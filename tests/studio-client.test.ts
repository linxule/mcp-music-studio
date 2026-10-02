import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStudioClient, createStudioHumanTransport } from '../dev/studio-client';
import { registerStudioAppTools } from '../src/studio-app-tools';
import { createStudioSession, type StudioSnapshot } from '../src/studio-session';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map(cleanup => cleanup())); vi.unstubAllGlobals(); });

async function mount() {
  const state: StudioSnapshot = {
    args: { abcNotation: 'X:1\nK:C\nCDEF|', title: 'Original', style: 'jazz' },
    settings: { warp: 125, room: false, loop: true },
    playback: 'stopped', status: 'Ready', error: null,
  };
  const session = createStudioSession({
    read: () => structuredClone(state),
    apply: async (args, settings, _isCancelled, onCommit) => {
      state.args = args; state.settings = settings;
      state.error = args.abcNotation === 'broken' ? 'Could not render score' : null;
      onCommit?.();
    },
    play: async () => { throw new Error('This workflow must not start playback'); },
    stop: () => {},
  }, { mode: 'score' });
  const app = new App({ name: 'Score fixture', version: '1' }, {}, { autoResize: false });
  registerStudioAppTools(app, session);
  const bridge = new AppBridge(null, { name: 'Studio fixture', version: '1' }, {});
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(hostTransport); await app.connect(appTransport);
  close.push(async () => { session.dispose(); await app.close(); await bridge.close(); });
  return { state, bridge, session, client: createStudioClient(bridge, 'score', { humanRequest: session }) };
}

describe('standalone studio client using actual widget app tools', () => {
  it('restores exact source arguments while preserving omitted sound settings', async () => {
    const { client } = await mount();
    const before = await client.request({ action: 'get' });
    const changed = await client.request({ action: 'set', expectedRevision: before.revision, args: { abcNotation: 'X:1\nK:C\nGABc|' } });
    expect(changed.args).toEqual({ abcNotation: 'X:1\nK:C\nGABc|' });
    expect(changed.settings).toEqual(before.settings);
    const imported = await client.request({ action: 'set', expectedRevision: changed.revision, args: changed.args, settings: { warp: 100 } });
    expect(imported.settings).toEqual({ soundFont: 'default', room: true, instrumentOverride: false, warp: 100, loop: false });
  });

  it('sees a native edit and undoes it through the same history', async () => {
    const { client, bridge } = await mount();
    const before = await client.request({ action: 'get' });
    await bridge.callTool({ name: 'set-score', arguments: { instanceId: before.instanceId, expectedRevision: before.revision, abcNotation: 'X:1\nK:C\nAAAA|' } });
    const current = await client.request({ action: 'get' });
    const undone = await client.request({ action: 'undo', expectedRevision: current.revision });
    expect(undone.args).toEqual(before.args);
    expect(undone.canUndo).toBe(false);
  });

  it('keeps a failed render visible and recoverable instead of losing its state', async () => {
    const { client } = await mount();
    const before = await client.request({ action: 'get' });
    const broken = await client.request({ action: 'set', expectedRevision: before.revision, args: { abcNotation: 'broken' } });
    expect(broken).toMatchObject({ error: 'Could not render score', canUndo: true, args: { abcNotation: 'broken' } });
    expect((await client.request({ action: 'undo', expectedRevision: broken.revision })).args).toEqual(before.args);
  });

  it('forwards an explicit stale instance rather than replacing it with its own ID', async () => {
    const { client, state } = await mount();
    const before = await client.request({ action: 'get' });
    await expect(client.request({ action: 'set', instanceId: crypto.randomUUID(), expectedRevision: before.revision, args: { abcNotation: 'wrong target' } })).rejects.toThrow('instance conflict');
    expect(state.args).toEqual(before.args);
  });

  it('shares a human question and native proposal, then human Apply and native Undo use one history', async () => {
    const { client, bridge } = await mount();
    const before = await client.request({ action: 'get' });
    const started = await client.beginReview('Make this phrase rise.');
    const review = started.sharedReview!;
    expect(review).toMatchObject({ question: 'Make this phrase rise.', explanation: '', stale: false,
      passage: { instanceId: before.instanceId, mode: 'score', revision: before.revision, text: before.args.abcNotation } });
    const proposed = 'X:1\nK:C\nGABc|';
    const stage = await bridge.callTool({ name: 'suggest-edit', arguments: {
      instanceId: before.instanceId, requestId: review.requestId, passage: review.passage,
      explanation: 'Raise the phrase to the next octave.', replacement: proposed,
    } });
    expect(stage.isError).toBeUndefined();
    const staged = await client.request({ action: 'get' });
    expect(staged.args).toEqual(before.args);
    expect(staged.revision).toBe(before.revision);
    expect(staged.sharedReview).toMatchObject({ requestId: review.requestId, replacement: proposed });
    const applied = await client.applyReview(review.requestId, staged.revision);
    expect(applied.args).toEqual({ ...before.args, abcNotation: proposed });
    expect(applied.settings).toEqual(before.settings);
    expect(applied.sharedReview).toBeNull();
    expect(applied.playback).toBe('stopped');
    const undone = await bridge.callTool({ name: 'undo-studio-edit', arguments: { instanceId: applied.instanceId, expectedRevision: applied.revision } });
    expect(undone.isError).toBeUndefined();
    expect((await client.request({ action: 'get' })).args).toEqual(before.args);
  });

  it('rejects an answer for a superseded question while preserving the new request and source', async () => {
    const { client, bridge } = await mount();
    const first = await client.beginReview('Explain the harmony.');
    const old = first.sharedReview!;
    const second = await client.beginReview('Explain the rhythm instead.  ', old.passage);
    const next = second.sharedReview!;
    expect(next.requestId).not.toBe(old.requestId);
    expect(next.question).toBe('Explain the rhythm instead.  ');
    expect(second.revision).toBe(first.revision);
    await expect(client.stageReview({ requestId: old.requestId, passage: old.passage, explanation: 'Late harmony answer.' })).rejects.toThrow('superseded');
    const late = await bridge.callTool({ name: 'suggest-edit', arguments: { instanceId: old.passage.instanceId,
      requestId: old.requestId, passage: old.passage, explanation: 'Old question answer.', replacement: 'wrong' } });
    expect(late.isError).toBe(true);
    expect((await client.request({ action: 'get' }))).toMatchObject({ args: first.args, revision: first.revision, sharedReview: next });
    const explained = await client.stageReview({ requestId: next.requestId, passage: next.passage, explanation: 'Four equal beats.' });
    expect(explained.sharedReview?.explanation).toBe('Four equal beats.');
    expect((await client.clearReview(next.requestId)).sharedReview).toBeNull();
    await expect(client.stageReview({ requestId: next.requestId, passage: next.passage, explanation: 'Late after clear.' })).rejects.toThrow('cleared');
  });

  it('keeps blank questions as new requests and stages repair despite an existing renderer error', async () => {
    const { client } = await mount();
    const initial = await client.request({ action: 'get' });
    await client.request({ action: 'set', expectedRevision: initial.revision, args: { abcNotation: 'broken' } });
    const question = await client.beginReview('Repair this score.');
    const blank = await client.beginReview('', question.sharedReview!.passage);
    expect(blank.sharedReview?.question).toBe('');
    expect(blank.sharedReview?.requestId).not.toBe(question.sharedReview?.requestId);
    const review = blank.sharedReview!;
    const staged = await client.stageReview({ requestId: review.requestId, passage: review.passage,
      explanation: 'Supply a complete ABC tune.', replacement: 'X:1\nK:C\nCDEF|' });
    expect(staged.error).toBe('Could not render score');
    expect(staged.sharedReview?.replacement).toBe('X:1\nK:C\nCDEF|');
    expect((await client.applyReview(review.requestId, staged.revision)).error).toBeNull();
  });

  it('does not expose begin, clear or Apply as model-callable app tools', async () => {
    const { bridge } = await mount();
    const tools = (await bridge.listTools({})).tools.map(tool => tool.name);
    expect(tools).toContain('explain-selection');
    expect(tools).toContain('suggest-edit');
    expect(tools).not.toContain('review-start');
    expect(tools).not.toContain('review-clear');
    expect(tools).not.toContain('review-apply');
    const modelOnly = createStudioClient(bridge, 'score');
    await expect(modelOnly.beginReview('Can I apply automatically?')).rejects.toThrow('human review panel');
  });
});

describe('human review loopback transport', () => {
  it('accepts only its opaque iframe response and rejects pending requests on teardown', async () => {
    const surface = new EventTarget();
    vi.stubGlobal('window', surface);
    const sent: Array<{ id: string }> = [];
    const frameWindow = { postMessage: (message: { id: string }) => sent.push(message) };
    const frame = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;
    const transport = createStudioHumanTransport(frame);
    const request = transport.request({ action: 'review-clear', requestId: 'active' });
    const state = { mode: 'score', instanceId: 'widget', revision: 3, sharedReview: null };
    const response = (source: unknown, id: string) => surface.dispatchEvent(Object.assign(new Event('message'), {
      source, origin: 'null', data: { channel: 'music-studio-local-result', id, state },
    }));
    response({}, sent[0]!.id);
    response(frameWindow, 'different-request');
    response(frameWindow, sent[0]!.id);
    expect(await request).toEqual(state);
    const pending = transport.request({ action: 'review-clear', requestId: 'another' });
    transport.dispose();
    await expect(pending).rejects.toThrow('closed');
    await expect(transport.request({ action: 'get' })).rejects.toThrow('closed');
  });
});
