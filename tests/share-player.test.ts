// The full player on share links (src/share-host.ts + worker routes /play,
// /score, /p/<id>, /widget/strudel, /widget/sheet, /s/<id>): the real widget hosted by a page of our
// own, and a live session's second screen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../worker/src/index";
import { JamSession, STOPPED_ACK_GRACE_MS, type SessionStorage } from "../worker/src/session-do";
import { appendEvents, newSession } from "../src/shared/session";

const ORIGIN = "https://music-studio.linxule.com";
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
const ID = "abcdefghijklmnop";

function memoryStorage(): SessionStorage {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined,
    put: async (k, v) => void map.set(k, structuredClone(v)),
    deleteAll: async () => void map.clear(),
    setAlarm: async (t) => void (alarm = t),
    getAlarm: async () => alarm,
  };
}

/** A JAM namespace over real JamSession objects, one per id. */
function fakeJam() {
  const objects = new Map<string, JamSession>();
  const obj = (id: string) => {
    if (!objects.has(id)) objects.set(id, new JamSession({ storage: memoryStorage() }));
    return objects.get(id)!;
  };
  return {
    obj,
    binding: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: (input: string, init?: RequestInit) => obj(id).fetch(new Request(input, init)),
      }),
    },
  };
}

const initOf = (html: string) =>
  JSON.parse(html.match(/<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/)![1]!);

describe("the share host", () => {
  const source = readFileSync(new URL("../src/share-host.ts", import.meta.url), "utf8");

  it("hands the widget the pattern with autoplay OFF — a share plays on a press", () => {
    expect(source).toMatch(/code: init\.code, autoplay: false/);
  });

  it("hands the sheet widget the score with autoplay OFF, which the widget honours", () => {
    expect(source).toMatch(/\{ \.\.\.init\.score, autoplay: false \}/);
    const widget = readFileSync(new URL("../src/mcp-app.ts", import.meta.url), "utf8");
    expect(widget).toMatch(/autoplay: args\.autoplay !== false/);
  });

  it("re-checks playPressed when the sheet widget logs a press (its reports would replace the edit report)", () => {
    expect(source).toMatch(/onloggingmessage[\s\S]{0,120}"play-pressed"[\s\S]{0,40}checkPlayPressed/);
    const widget = readFileSync(new URL("../src/mcp-app.ts", import.meta.url), "utf8");
    expect(widget).toMatch(/sendLog\(\{[^}]*event: "play-pressed"/);
  });

  it("grants the frame what a chat host can't: mic, motion sensors, MIDI, fullscreen", () => {
    const allow = source.match(/FRAME_ALLOW = "([^"]+)"/)![1];
    for (const feature of ["autoplay", "microphone", "accelerometer", "gyroscope", "midi", "fullscreen"]) {
      expect(allow).toContain(feature);
    }
  });

  it("offers downloads but no chat to message", () => {
    expect(source).toContain("downloadFile: {}");
    expect(source).not.toMatch(/\bmessage: \{/);
  });
});

describe("GET /s/<id> — a live session's second screen", () => {
  const page = (path: string, env: unknown) => worker.fetch(new Request(`${ORIGIN}${path}`), env as never, CTX);

  it("404s an unknown or expired session and 400s a malformed id", async () => {
    const jam = fakeJam();
    const gone = await page(`/s/${ID}`, { JAM: jam.binding });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("ended");
    expect((await page("/s/NOT-AN-ID", { JAM: jam.binding })).status).toBe(400);
  });

  it("loads the session's newest pattern and joins it", async () => {
    const jam = fakeJam();
    await jam.obj(ID).fetch(new Request(`https://session/init?id=${ID}`, { method: "POST" }));
    await jam.obj(ID).fetch(new Request("https://session/update", { method: "POST", body: JSON.stringify({ code: 's("bd*4")' }) }));
    const res = await page(`/s/${ID}`, { JAM: jam.binding });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const init = initOf(await res.text());
    expect(init.code).toBe('s("bd*4")');
    expect(init.session).toEqual({ id: ID, origin: ORIGIN, rev: 1 });
    expect(init.classic).toBeUndefined();
  });

  it("falls back to the code the performer last ran, then to a waiting placeholder", async () => {
    const jam = fakeJam();
    await jam.obj(ID).fetch(new Request(`https://session/init?id=${ID}`, { method: "POST" }));
    expect(initOf(await (await page(`/s/${ID}`, { JAM: jam.binding })).text()).code).toContain("no pattern yet");
    await jam.obj(ID).fetch(
      new Request("https://session/events", { method: "POST", body: JSON.stringify({ events: [{ t: "edit", code: 'note("c e g")', cycle: 3 }] }) }),
    );
    expect(initOf(await (await page(`/s/${ID}`, { JAM: jam.binding })).text()).code).toBe('note("c e g")');
  });

  it("`current` reads without writing", async () => {
    const storage = memoryStorage();
    let puts = 0;
    const counted: SessionStorage = { ...storage, put: async (k, v) => { puts++; return storage.put(k, v); } };
    const obj = new JamSession({ storage: counted });
    await obj.fetch(new Request(`https://session/init?id=${ID}`, { method: "POST" }));
    const before = puts;
    expect((await obj.fetch(new Request("https://session/current"))).status).toBe(204);
    expect(puts).toBe(before);
  });
});

describe("two screens on one session", () => {
  it("a stopped screen's 'loaded' does not beat the playing player's answer", async () => {
    let now = 1_000_000;
    const sleepers: Array<{ at: number; resolve: () => void }> = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: now + ms, resolve }));
    const tick = async (ms: number) => {
      now += ms;
      for (const s of sleepers.filter((x) => x.at <= now)) {
        sleepers.splice(sleepers.indexOf(s), 1);
        s.resolve();
      }
      await new Promise((r) => setTimeout(r, 0));
    };
    const obj = new JamSession({ storage: memoryStorage() }, undefined, () => now, sleep);
    const call = (path: string, init?: RequestInit) => obj.fetch(new Request(`https://session/${path}`, init));
    await call(`init?id=${ID}`, { method: "POST" });
    await call("next?after=0&cycle=4&cps=0.5&state=playing&wait=0");
    const update = call("update", { method: "POST", body: JSON.stringify({ code: "x", quantize: 1 }) });
    await new Promise((r) => setTimeout(r, 0));
    // The second screen (stopped) answers first…
    await call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "applied", rev: 1, ok: true, cycle: null, report: "Loaded into the editor" }] }) });
    // …and the playing player a moment later, inside the grace.
    await tick(STOPPED_ACK_GRACE_MS / 2);
    await call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "applied", rev: 1, ok: true, cycle: 6 }] }) });
    const outcome = await (await update).json();
    expect(outcome.applied).toMatchObject({ rev: 1, ok: true, cycle: 6 });
  });

  it("the session keeps the playing answer as the latest", () => {
    const d = newSession(ID, 0);
    appendEvents(d, [{ t: "applied", rev: 1, ok: true, cycle: 6 }], 1);
    appendEvents(d, [{ t: "applied", rev: 1, ok: true, cycle: null }], 2);
    expect(d.lastApplied).toMatchObject({ cycle: 6 });
  });
});
