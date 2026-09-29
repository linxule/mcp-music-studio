import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { StudioCommand, StudioSnapshot } from '../src/studio-session';
import type { StudioMode } from '../src/studio-review';

type Snapshot = StudioSnapshot & { revision: number };
/** A disposable player: its editor, runtime and history are separate from the draft. */
export function createAudition(host: HTMLElement, mode: StudioMode) {
  const frame = document.createElement('iframe');
  frame.title = 'Suggestion preview';
  frame.className = 'audition-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  host.append(frame);
  let disposed = false;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  void initialized.catch(() => {});
  const timer = setTimeout(() => fail(new Error('Preview did not load. Try again.')), 15_000);
  const bridge = new AppBridge(null, { name: 'Music suggestion preview', version: '0.1.0' }, {
    updateModelContext: { text: {}, structuredContent: {} }, logging: {},
  }, { hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { width: host.clientWidth, height: 480 } } });
  bridge.oninitialized = () => { clearTimeout(timer); finish(); };
  bridge.onupdatemodelcontext = async () => ({});
  const pending = new Map<string, { resolve: (value: Snapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function receive(event: MessageEvent) {
    if (event.source !== frame.contentWindow || event.data?.channel !== 'music-studio-local-result') return;
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(event.data.id);
    if (event.data.error) waiter.reject(new Error(event.data.error)); else waiter.resolve(event.data.state);
  }
  window.addEventListener('message', receive);
  const ready = (async () => {
    await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    if (disposed) throw new Error('Preview closed.');
    frame.src = `/widgets/${mode === 'live' ? 'strudel-app' : 'mcp-app'}.html?studio=1&audition=1`;
    await initialized;
  })();
  void ready.catch(() => {});
  async function request(command: StudioCommand): Promise<Snapshot> {
    await ready;
    if (disposed) throw new Error('Preview closed.');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Preview did not respond. Try again.')); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow!.postMessage({ channel: 'music-studio-local', id, command }, '*');
    });
  }
  return {
    async load(args: Record<string, unknown>, settings?: Record<string, unknown>) {
      const state = await request({ action: 'get' });
      return request({ action: 'set', args, settings, expectedRevision: state.revision });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      fail(new Error('Preview closed.'));
      // Removing the browsing context also ends its audio, including late loads.
      frame.contentWindow?.postMessage({ channel: 'music-studio-local', id: crypto.randomUUID(), command: { action: 'stop' } }, '*');
      frame.remove();
      window.removeEventListener('message', receive);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Preview closed.')); }
      pending.clear();
      void bridge.close().catch(() => {});
    },
  };
}
