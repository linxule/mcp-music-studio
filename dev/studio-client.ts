import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { StudioCommand, StudioState } from '../src/studio-session';
import type { StudioMode } from '../src/studio-review';
import { sourceOf, type Passage } from '../src/studio-review';

export type WidgetSnapshot = StudioState;

/** One client belongs to one mounted iframe. Never silently adopt a remount. */
export function createStudioClient(bridge: AppBridge, mode: StudioMode, options: {
  humanRequest?: (command: StudioCommand) => Promise<WidgetSnapshot>;
} = {}) {
  let instanceId: string | undefined;
  let discovery: Promise<void> | undefined;
  const editTool = mode === 'live' ? 'set-pattern' : 'set-score';
  const names = {
    get: 'get-studio-state', set: editTool, play: 'play-current-music',
    stop: 'stop-music', undo: 'undo-studio-edit', swap: 'swap-pattern',
  } as const;

  function accept(state: WidgetSnapshot | undefined): WidgetSnapshot {
    if (!state || state.mode !== mode || typeof state.instanceId !== 'string' || !state.instanceId || !Number.isSafeInteger(state.revision)) {
      throw new Error('The music widget returned an incompatible state. Rebuild and reload.');
    }
    if (instanceId && state.instanceId !== instanceId) throw new Error('The music widget was replaced. Reopen the workspace before editing.');
    instanceId = state.instanceId;
    return state;
  }

  async function invoke(name: string, args: Record<string, unknown>): Promise<WidgetSnapshot> {
    const result = await bridge.callTool({ name, arguments: args }, { timeout: 30_000 });
    // Rendering may fail after the source changed. Keep that state visible so
    // the human can recover through Undo; only command failures lack a state.
    const state = result.structuredContent as WidgetSnapshot | undefined;
    if (result.isError && !state) {
      const detail = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      throw new Error(detail || 'The music widget could not complete this action. Read its state before retrying.');
    }
    return accept(state);
  }

  async function discover() {
    const listing = await bridge.listTools({}, { timeout: 15_000 });
    const available = new Set(listing.tools.map(tool => tool.name));
    // swap-pattern is live-only (and newer): optional for discovery.
    if ([names.get, names.set, names.play, names.stop, names.undo, 'explain-selection', 'suggest-edit'].some(name => !available.has(name))) {
      throw new Error('This widget does not provide studio tools. Rebuild and reload.');
    }
    await invoke(names.get, { mode });
  }

  async function request(command: StudioCommand): Promise<WidgetSnapshot> {
    await (discovery ??= discover());
    const target = command.instanceId ?? instanceId;
    const args: Record<string, unknown> = { mode, instanceId: target };
    if (command.action === 'review-stage') {
      return invoke(command.replacement === undefined ? 'explain-selection' : 'suggest-edit', {
        instanceId: target, requestId: command.requestId, passage: command.passage,
        explanation: command.explanation,
        ...(command.replacement === undefined ? {} : { replacement: command.replacement }),
      });
    }
    if (command.action === 'review-start' || command.action === 'review-clear' || command.action === 'review-apply') {
      if (!options.humanRequest) throw new Error('Begin, clear and apply review actions belong to the human review panel.');
      return accept(await options.humanRequest({ ...command, mode, instanceId: target }));
    }
    if (command.action === 'set') {
      Object.assign(args, command.args, { mode, instanceId: target, expectedRevision: command.expectedRevision, replace: command.replace ?? true });
      if (command.settings !== undefined) args.settings = command.settings;
    } else if (command.action === 'play' || command.action === 'undo') {
      args.expectedRevision = command.expectedRevision;
    } else if (command.action === 'swap') {
      if (mode !== 'live') throw new Error('swap-pattern is only available in live mode.');
      return invoke(names.swap, {
        instanceId: target, expectedRevision: command.expectedRevision, code: command.args?.code,
        ...(command.quantize === undefined ? {} : { quantize: command.quantize }),
      });
    }
    return invoke(names[command.action], args);
  }

  return {
    request,
    async beginReview(question: string, passage?: Passage) {
      const state = await request({ action: 'get' });
      const selection = state.selection ?? { from: 0, to: sourceOf(mode, state).length, text: sourceOf(mode, state) };
      return request({ action: 'review-start', question, passage: passage ?? { instanceId: state.instanceId, mode, revision: state.revision, ...selection }, expectedRevision: state.revision });
    },
    stageReview: (answer: { requestId: string; passage: Passage; explanation: string; replacement?: string }) => request({ action: 'review-stage', ...answer }),
    clearReview: (requestId: string) => request({ action: 'review-clear', requestId }),
    applyReview: (requestId: string, expectedRevision: number) => request({ action: 'review-apply', requestId, expectedRevision }),
  };
}

/** Human controls use the existing loopback-only dispatcher, never model tools.
 * The iframe is opaque; match its WindowProxy and correlated ID, not its origin.
 */
export function createStudioHumanTransport(frame: HTMLIFrameElement) {
  const pending = new Map<string, { resolve: (state: WidgetSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.data?.channel !== 'music-studio-local-result') return;
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    pending.delete(event.data.id); clearTimeout(waiter.timer);
    if (event.data.error) waiter.reject(new Error(String(event.data.error)));
    else waiter.resolve(event.data.state as WidgetSnapshot);
  };
  window.addEventListener('message', receive);
  return {
    request(command: StudioCommand): Promise<WidgetSnapshot> {
      if (disposed) return Promise.reject(new Error('The human review transport is closed.'));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The human review action timed out. Read the session before retrying.')); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        frame.contentWindow?.postMessage({ channel: 'music-studio-local', id, command }, '*');
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; window.removeEventListener('message', receive);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('The human review transport is closed.')); }
      pending.clear();
    },
  };
}
