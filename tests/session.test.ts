import { describe, expect, it, vi } from "vitest";
import { sequence, stack } from "@strudel/core";
import {
  staleWidgetHint,
  appendEvents,
  coerceEvents,
  describeSession,
  estimatedCycle,
  mintSessionId,
  newSession,
  nextBoundary,
  queuePattern,
  recordHeartbeat,
  SESSION_ID_RE,
  SESSION_IDLE_TTL_MS,
  SESSION_ENDED_TTL_MS,
  SESSION_MAX_EDIT_BODIES,
  SESSION_MAX_EVENTS,
  SESSION_MAX_BYTES,
  SESSION_HEARTBEAT_LATE_MS,
  SESSION_WIDGET_STALE_MS,
  sessionBytes,
  type SessionData,
} from "../src/shared/session";
import { spliceAt, hapStart, settle, isSpliced, swapOutcome } from "../src/shared/splice";
import { JamSession, MAX_LISTENERS, MAX_POLL_WAITERS, type SessionStorage } from "../worker/src/session-do";
import { IDLE_PARK_MS, PASS_ANSWER_MS, SessionClient } from "../src/session-client";
import {
  attachSession,
  buildUpdateSessionResult,
  httpSessionBackend,
  registerSessionTools,
  sessionNote,
  type SessionBackend,
} from "../src/shared/session-tools";

const ID = "abcdefghijklmnop";

describe("session ids", () => {
  it("mints 16 base32 characters", () => {
    for (let i = 0; i < 50; i++) expect(mintSessionId()).toMatch(SESSION_ID_RE);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "ABCDEFGHIJKLMNOP", "abcdefghijklmno", "abcdefghijklmnop1", "../../etc/passwd", "abcdefghijklmn01"]) {
      expect(SESSION_ID_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("coerceEvents (the widget is untrusted)", () => {
  it("keeps known kinds, re-typed and bounded", () => {
    const out = coerceEvents([
      { t: "tap", cycle: 3.5, x: 2, y: -1, extra: "dropped" },
      { t: "report", text: "x".repeat(5000) },
      { t: "edit", cycle: "nope", code: "s('bd')" },
      { t: "applied", rev: 2, ok: "yes", error: 7 },
      { t: "pass" },
      { t: "update", rev: 99 }, // only the server writes these
      { t: "nonsense" },
      null,
      "string",
    ]);
    expect(out).toEqual([
      { t: "tap", cycle: 3.5, x: 1, y: 0 },
      { t: "report", text: "x".repeat(2000) },
      { t: "edit", cycle: null, code: "s('bd')", chars: 7 },
      { t: "applied", rev: 2, ok: false, cycle: null, error: undefined, report: undefined },
      { t: "pass", cycle: null },
    ]);
  });
  it("ignores a non-array and caps the batch", () => {
    expect(coerceEvents({ t: "tap" })).toEqual([]);
    expect(coerceEvents(Array.from({ length: 500 }, () => ({ t: "pass" })))).toHaveLength(64);
  });
});

describe("the event log", () => {
  it("caps events and keeps only the newest edit bodies", () => {
    const data = newSession(ID, 0);
    for (let i = 0; i < SESSION_MAX_EVENTS + 50; i++) appendEvents(data, [{ t: "pass", cycle: i }], i);
    expect(data.events).toHaveLength(SESSION_MAX_EVENTS);
    expect(data.events[0].seq).toBe(51);
    for (let i = 0; i < 6; i++) appendEvents(data, [{ t: "edit", cycle: i, code: `code ${i}`, chars: 6 }], 1000 + i);
    const edits = data.events.filter((e) => e.t === "edit");
    expect(edits.filter((e) => e.t === "edit" && e.code !== null)).toHaveLength(SESSION_MAX_EDIT_BODIES);
    expect(edits.at(-1)).toMatchObject({ code: "code 5" });
  });
});

describe("quantize", () => {
  it("finds the next boundary past a lead", () => {
    expect(nextBoundary(3.2, 1)).toBe(4);
    expect(nextBoundary(3.9, 1, 0.3)).toBe(5);
    expect(nextBoundary(4, 1)).toBe(4);
    expect(nextBoundary(5, 4)).toBe(8);
    expect(nextBoundary(7.95, 8, 0.1)).toBe(16);
    expect(nextBoundary(3.2, 0)).toBe(3.2);
  });
  it("extrapolates the player's clock only while it plays", () => {
    expect(estimatedCycle({ at: 1000, cycle: 10, cps: 0.5, state: "playing" }, 5000)).toBe(12);
    expect(estimatedCycle({ at: 1000, cycle: 10, cps: 0.5, state: "stopped" }, 5000)).toBe(10);
    expect(estimatedCycle(null, 5000)).toBeNull();
  });
});

describe("describeSession — what the model reads", () => {
  const playing = (): SessionData => {
    const data = newSession(ID, 0);
    appendEvents(data, [{ t: "joined", host: "claude.ai", platform: "mobile", caps: ["message", "updateModelContext"] }], 1000);
    appendEvents(data, [{ t: "report", text: "Strudel widget: playing (visuals: none)" }], 2000);
    recordHeartbeat(data, { cycle: 10, cps: 0.5, state: "playing" }, 10_000);
    return data;
  };

  it("says when no player has joined", () => {
    expect(describeSession(newSession(ID, 0), 5000)).toContain("no player has joined yet");
  });

  it("names the host, its state and the clock", () => {
    const text = describeSession(playing(), 12_000);
    expect(text).toContain("player on claude.ai · mobile (host offers: message, updateModelContext)");
    expect(text).toContain("playing, around cycle 11.0 at cps 0.5");
    expect(text).toContain("widget report: Strudel widget: playing (visuals: none)");
  });

  it("folds taps, shows the human's code and the pass", () => {
    const data = playing();
    data.readSeq = data.seq;
    appendEvents(
      data,
      [
        { t: "tap", cycle: 12.1, x: 0.1, y: 0.9 },
        { t: "tap", cycle: 12.6, x: 0.2, y: 0.8 },
        { t: "tap", cycle: 13.0, x: 0.15, y: 0.85 },
        { t: "edit", cycle: 14, code: 's("bd*2")', chars: 9 },
        { t: "pass", cycle: 15 },
      ],
      20_000,
    );
    const text = describeSession(data, 21_000);
    expect(text).toContain("Since your last read:");
    expect(text).not.toContain("widget report"); // already read
    expect(text).toContain("the human tapped 3 times, cycles 12.1–13.0 (mostly left, low;");
    expect(text).toContain("cycle 14.0: the human edited the code and ran it (9 chars) — their version is below.");
    expect(text).toContain("cycle 15.0: the human passed the turn to you.");
    expect(text).toContain('```js\ns("bd*2")\n```');
  });

  it("reports an update's outcome", () => {
    const data = playing();
    const p = queuePattern(data, 's("hh*8")', 4, 30_000);
    expect(describeSession(data, 30_500)).toContain(`latest update (rev ${p.rev}) is queued`);
    appendEvents(data, [{ t: "applied", rev: p.rev, ok: false, cycle: null, error: "osc is not defined" }], 31_000);
    expect(describeSession(data, 31_500)).toContain("FAILED in the widget: osc is not defined");
  });

  it("warns when the player has gone quiet", () => {
    expect(describeSession(playing(), 10_000 + 120_000)).toContain("may be closed, scrolled away");
  });
});

describe("spliceAt — the bar-quantized swap", () => {
  it("plays the old pattern before the boundary and the new one from it", () => {
    const spliced = spliceAt(sequence("a", "a", "a", "a"), sequence("b", "b", "b", "b"), 2, stack);
    const haps = spliced.queryArc(0, 4).sort((x: any, y: any) => hapStart(x) - hapStart(y));
    expect(haps).toHaveLength(16);
    expect(haps.filter((h: any) => hapStart(h) < 2).every((h: any) => h.value === "a")).toBe(true);
    expect(haps.filter((h: any) => hapStart(h) >= 2).every((h: any) => h.value === "b")).toBe(true);
  });
  it("reads Strudel's Fraction times as numbers", () => {
    const [hap] = sequence("x", "y").queryArc(0.5, 0.6);
    expect(hapStart(hap)).toBe(0.5);
  });
});

/** In-memory Durable Object storage with a controllable clock. */
function fakeState() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: SessionStorage = {
    get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined,
    put: async (k, v) => void map.set(k, structuredClone(v)),
    deleteAll: async () => {
      map.clear();
      alarm = null;
    },
    setAlarm: async (t) => void (alarm = t),
    getAlarm: async () => alarm,
  };
  return { storage, map, alarm: () => alarm };
}

function harness() {
  const state = fakeState();
  let now = 1_000_000;
  const sleepers: Array<{ at: number; resolve: () => void }> = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: now + ms, resolve }));
  const advance = async (ms: number) => {
    now += ms;
    for (const s of sleepers.filter((s) => s.at <= now)) {
      sleepers.splice(sleepers.indexOf(s), 1);
      s.resolve();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const obj = new JamSession({ storage: state.storage }, undefined, () => now, sleep);
  const call = (path: string, init?: RequestInit) => obj.fetch(new Request(`https://session/${path}`, init));
  return { obj, state, call, advance, sleeping: () => sleepers.length, setNow: (t: number) => (now = t) };
}

describe("JamSession (Durable Object)", () => {
  it("does not exist, or write anything, until init", async () => {
    const h = harness();
    expect((await h.call("state")).status).toBe(404);
    expect((await h.call("events", { method: "POST", body: '{"events":[{"t":"pass"}]}' })).status).toBe(404);
    expect(h.state.map.size).toBe(0);
    expect((await h.call(`init?id=${ID}`, { method: "POST" })).status).toBe(200);
    expect((await h.call("state")).status).toBe(200);
  });

  it("refuses a malformed id at init", async () => {
    const h = harness();
    expect((await h.call("init?id=NOPE", { method: "POST" })).status).toBe(400);
  });

  it("wakes a waiting poll with the model's update and returns the player's answer", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    // The widget polls: no pattern yet, so the request waits.
    const poll = h.call("next?after=0&cycle=8&cps=0.5&state=playing");
    await h.advance(10);
    // The model updates; that wakes the poll.
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: 's("bd*4")', quantize: 1 }) });
    const polled = await poll;
    expect(polled.status).toBe(200);
    const pattern = await polled.json();
    expect(pattern).toMatchObject({ rev: 1, code: 's("bd*4")', quantize: 1 });
    // The widget answers.
    await h.call("events", {
      method: "POST",
      body: JSON.stringify({ events: [{ t: "applied", rev: 1, ok: true, cycle: 9, report: "Strudel widget: playing" }] }),
    });
    const outcome = await (await update).json();
    expect(outcome.applied).toMatchObject({ rev: 1, ok: true, cycle: 9 });
    expect(outcome.pattern.code).toBe(""); // not echoed back to the model
    // The server's own estimate errs late (swap lead + SERVER_ETA_MARGIN_S):
    // cycle 8 at cps 0.5 → the bar after 8 + 1.175 = 10.
    expect(outcome.boundary).toBe(10);
  });

  it("does not wait for a player that never joined", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const outcome = await (await h.call("update", { method: "POST", body: JSON.stringify({ code: "x" }) })).json();
    expect(outcome.applied).toBeNull();
    expect(outcome.widgetSeenMsAgo).toBeNull();
  });

  it("times out an unanswered update", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("next?after=0&cycle=1&cps=0.5&state=playing&wait=0");
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: "x", quantize: 8 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await h.advance(9_001);
    const outcome = await (await update).json();
    expect(outcome.applied).toBeNull();
    expect(outcome.boundary).toBe(8);
  });

  it("hands a late-joining player the latest pattern at once", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("update", { method: "POST", body: JSON.stringify({ code: "one" }) });
    await h.call("update", { method: "POST", body: JSON.stringify({ code: "two" }) });
    const res = await h.call("next?after=0&state=stopped");
    expect(await res.json()).toMatchObject({ rev: 2, code: "two" });
    expect((await h.call("next?after=2&state=stopped&wait=0")).status).toBe(204);
  });

  it("advances the read mark unless peeking", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "pass", cycle: 3 }] }) });
    expect((await (await h.call("state?peek=1")).json()).text).toContain("passed the turn");
    expect((await (await h.call("state")).json()).text).toContain("passed the turn");
    expect((await (await h.call("state")).json()).text).toContain("Nothing new since your last read.");
  });

  it("rejects oversized and malformed bodies", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    expect((await h.call("events", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await h.call("events", { method: "POST", body: "x".repeat(300 * 1024) })).status).toBe(400);
    expect((await h.call("update", { method: "POST", body: JSON.stringify({ code: "" }) })).status).toBe(400);
  });

  it("deletes itself after the idle TTL", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    expect(h.state.alarm()).not.toBeNull();
    await h.obj.alarm(); // too early: re-arms
    expect(h.state.map.size).toBe(1);
    h.setNow(1_000_000 + SESSION_IDLE_TTL_MS + 1);
    await h.obj.alarm();
    expect(h.state.map.size).toBe(0);
    expect((await h.call("state")).status).toBe(404);
  });
});

describe("SessionClient (widget side)", () => {
  function clientHarness(responses: Array<() => Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/events")) return new Response('{"ok":true}');
      const next = responses.shift();
      if (!next) return new Promise<Response>(() => {}); // hang: the test is over
      return next();
    });
    const applied: number[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 4.25, cps: 0.5, state: "playing" }),
      apply: async (p) => {
        applied.push(p.rev);
        return { ok: true, cycle: 5, report: "playing" };
      },
    });
    return { client, calls, applied };
  }

  it("joins, polls with its clock, applies and answers", async () => {
    const h = clientHarness([
      () => new Response(null, { status: 204 }),
      () => new Response(JSON.stringify({ rev: 1, code: "x", quantize: 1, at: 0 })),
    ]);
    h.client.start({ host: "test" });
    await vi.waitFor(() => expect(h.applied).toEqual([1]));
    await vi.waitFor(() =>
      expect(h.calls.some((c) => c.url.endsWith("/events") && String(c.init?.body).includes('"t":"applied"'))).toBe(true),
    );
    const polls = h.calls.filter((c) => c.url.includes("/next?"));
    expect(polls[0].url).toContain("after=0");
    expect(polls[0].url).toContain("cycle=4.25");
    expect(polls[0].url).toContain("cps=0.5");
    expect(polls[0].url).toContain("state=playing");
    expect(polls[2].url).toContain("after=1");
    const join = h.calls.find((c) => c.url.endsWith("/events"));
    expect(join?.init?.headers).toMatchObject({ "content-type": "text/plain;charset=UTF-8" });
    h.client.stop();
  });

  it("stops on 404 (the session expired)", async () => {
    const onGone = vi.fn();
    const h = clientHarness([() => new Response(null, { status: 404 })]);
    (h.client as any).env.onGone = onGone;
    h.client.start({});
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });

  it("batches taps", async () => {
    const h = clientHarness([]);
    h.client.log({ t: "tap", cycle: 1, x: 0.5, y: 0.5 });
    h.client.log({ t: "tap", cycle: 1.25, x: 0.5, y: 0.5 });
    await vi.waitFor(() => expect(h.calls.filter((c) => c.url.endsWith("/events"))).toHaveLength(1));
    expect(JSON.parse(String(h.calls[0].init?.body)).events).toHaveLength(2);
    h.client.stop();
  });
});

describe("session tools", () => {
  const backend = (over: Partial<SessionBackend> = {}): SessionBackend => ({
    create: async () => ID,
    state: async () => "state text",
    update: async () => null,
    ...over,
  });

  it("attachSession adds the id for the model and _meta for the widget", async () => {
    const base = { content: [{ type: "text" as const, text: "ready." }], _meta: { viewUUID: "v" } };
    const out = await attachSession(base, backend(), "https://lab.example");
    expect((out.content[0] as any).text).toContain(sessionNote(ID));
    expect(out._meta).toEqual({ viewUUID: "v", session: { id: ID, origin: "https://lab.example" } });
  });

  it("a session that cannot open never fails the play", async () => {
    const base = { content: [{ type: "text" as const, text: "ready." }] };
    const out = await attachSession(base, backend({ create: async () => Promise.reject(new Error("down")) }), "o");
    expect(out.isError).toBeUndefined();
    expect((out.content[0] as any).text).toContain("could not be opened");
    expect(out._meta?.session).toBeUndefined();
  });

  it("update-session refuses code that does not parse, without sending it", async () => {
    const tools: Record<string, (args: any) => Promise<any>> = {};
    const update = vi.fn();
    registerSessionTools(
      { registerTool: (name: string, _c: unknown, cb: any) => void (tools[name] = cb) },
      backend({ update }),
      async () => ({ message: "Unexpected token", line: 3, column: 9 }),
    );
    const res = await tools["update-session"]({ session: ID, code: "s(" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unexpected token (3:9)");
    expect(update).not.toHaveBeenCalled();
  });

  it("words each outcome", () => {
    const pattern = { rev: 3, code: "", quantize: 4, at: 0 };
    const base = { pattern, widgetSeenMsAgo: 2000, estCycle: 10, boundary: 12, cps: 0.5 };
    expect(buildUpdateSessionResult(ID, null).isError).toBe(true);
    const ok = buildUpdateSessionResult(ID, {
      ...base,
      applied: { seq: 1, at: 0, t: "applied", rev: 3, ok: true, cycle: 12, report: "Strudel widget: playing" },
    });
    expect((ok.content[0] as any).text).toContain("Rev 3 applied — it takes over at cycle 12.0. Strudel widget: playing");
    const bad = buildUpdateSessionResult(ID, {
      ...base,
      applied: { seq: 1, at: 0, t: "applied", rev: 3, ok: false, cycle: null, error: "boom" },
    });
    expect(bad.isError).toBe(true);
    expect((buildUpdateSessionResult(ID, { ...base, applied: null }).content[0] as any).text).toContain(
      "queued — estimated to take over around cycle 12.0 (~4 s from now)",
    );
    expect(
      (buildUpdateSessionResult(ID, { ...base, applied: null, widgetSeenMsAgo: null }).content[0] as any).text,
    ).toContain("no player has joined this session yet");
  });

  it("httpSessionBackend speaks the routes", async () => {
    const seen: string[] = [];
    const b = httpSessionBackend(async (path, init) => {
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/session/new") return new Response(JSON.stringify({ id: ID }));
      if (path.endsWith("/state")) return new Response(JSON.stringify({ text: "hi" }));
      return new Response(null, { status: 404 });
    });
    expect(await b.create()).toBe(ID);
    expect(await b.state(ID)).toBe("hi");
    expect(await b.update(ID, "x", 1)).toBeNull();
    expect(seen).toEqual(["POST /session/new", `GET /session/${ID}/state`, `POST /session/${ID}/update`]);
  });
});

describe("controls in the session log", () => {
  it("shows the strip as it stands and folds moves", () => {
    const data = newSession(ID, 0);
    appendEvents(data, [{ t: "joined", host: "h" }], 0);
    recordHeartbeat(data, { cycle: 1, cps: 0.5, state: "playing" }, 0);
    appendEvents(
      data,
      coerceEvents([
        { t: "controls", list: [{ name: "rain", kind: "fader", value: 0, min: 0, max: 1 }, { name: "drop", kind: "pad", value: 0 }, { name: "space", kind: "xy", value: [0.5, 0.5] }] },
        { t: "control", name: "rain", kind: "fader", value: 0.3, cycle: 2 },
        { t: "control", name: "rain", kind: "fader", value: 0.9, cycle: 3 },
        { t: "control", name: "drop", kind: "pad", value: 1, cycle: 4 },
        { t: "control", name: "drop", kind: "pad", value: 0, cycle: 4.2 },
        { t: "control", name: "drop", kind: "pad", value: 1, cycle: 5 },
        { t: "control", name: "space", kind: "xy", value: [0.1, 0.9], cycle: 6 },
      ]),
      1000,
    );
    const text = describeSession(data, 2000);
    expect(text).toContain("Controls on the player now: rain (fader 0–1) 0.9; drop (pad) on; space (xy) x 0.10, y 0.90.");
    expect(text).toContain("- the human moved fader 'rain' 2 times, ending at 0.9 (cycles 2.0–3.0).");
    expect(text).toContain("- the human pressed pad 'drop' 2 times (4.0, 5.0); now on.");
    expect(text).toContain("- the human moved xy 'space' to x 0.10, y 0.90 (cycle 6.0).");
  });
});

describe("SessionClient heartbeat", () => {
  it("re-polls when the player's state changes mid-poll", async () => {
    let state = "stopped";
    const urls: string[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events")) return new Response("{}");
        urls.push(url);
        // Hang like a long-poll until aborted.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 0, cps: 0.5, state }),
      apply: async () => ({ ok: true, cycle: 0 }),
    });
    client.start({});
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain("state=stopped");
    state = "playing";
    await vi.waitFor(() => expect(urls.some((u) => u.includes("state=playing"))).toBe(true));
    client.stop();
  });
});

describe("a heard Pass that gets no answer", () => {
  function passHarness(listeningHeaders: string[], pattern?: () => Response) {
    let timers: Array<{ fn: () => void; ms: number }> = [];
    const unanswered = vi.fn();
    let served = false;
    let polls = 0;
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events")) return new Response('{"ok":true,"listening":true}');
        polls++;
        const header = listeningHeaders.shift();
        if (header !== undefined) return new Response(null, { status: 204, headers: { "x-session-listening": header } });
        if (pattern && !served) {
          served = true;
          return pattern();
        }
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
      },
      setTimeout: (fn, ms) => {
        if (ms === PASS_ANSWER_MS) {
          timers.push({ fn, ms });
          return timers.length;
        }
        return setTimeout(fn, Math.min(ms, 5));
      },
      clearTimeout: (h) => (typeof h === "number" && h <= timers.length ? undefined : clearTimeout(h as any)),
      clock: () => ({ cycle: 1, cps: 0.5, state: "playing" }),
      apply: async () => ({ ok: true, cycle: 2 }),
      onPassUnanswered: unanswered,
    });
    const fire = () => {
      const due = timers;
      timers = [];
      for (const t of due) t.fn();
    };
    /** Every scripted header has been read and the next poll is hanging. */
    const drained = (n: number) => vi.waitFor(() => expect(polls).toBeGreaterThan(n));
    return { client, unanswered, fire, drained };
  }

  it("says so after PASS_ANSWER_MS when nothing came back", async () => {
    const h = passHarness([]);
    expect(await h.client.pass(3)).toBe(true);
    h.fire();
    expect(h.unanswered).toHaveBeenCalledTimes(1);
    h.client.stop();
  });

  it("an update counts as the answer", async () => {
    const h = passHarness([], () => new Response(JSON.stringify({ rev: 1, code: "x", quantize: 1, at: 0 })));
    expect(await h.client.pass(3)).toBe(true);
    h.client.start({});
    await vi.waitFor(() => expect((h.client as any).rev).toBe(1));
    h.fire();
    expect(h.unanswered).not.toHaveBeenCalled();
    h.client.stop();
  });

  it("listening again counts, but only after the listen ended (a stale '1' does not)", async () => {
    const stale = passHarness(["1"]);
    expect(await stale.client.pass(3)).toBe(true);
    stale.client.start({});
    await stale.drained(1);
    stale.fire();
    expect(stale.unanswered).toHaveBeenCalledTimes(1);
    stale.client.stop();

    const again = passHarness(["0", "1"]);
    expect(await again.client.pass(3)).toBe(true);
    again.client.start({});
    await again.drained(2);
    again.fire();
    expect(again.unanswered).not.toHaveBeenCalled();
    again.client.stop();
  });
});

describe("an idle player stops polling (cost)", () => {
  function idleHarness(initial: string) {
    let now = 0;
    let state = initial;
    const polls: string[] = [];
    let open = 0;
    const events: string[] = [];
    const statuses: string[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events")) {
          events.push(String(init?.body));
          return new Response("{}");
        }
        polls.push(url);
        open++;
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => {
            open--;
            reject(new Error("abort"));
          }),
        );
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      now: () => now,
      clock: () => ({ cycle: 0, cps: 0.5, state }),
      apply: async () => ({ ok: true, cycle: 0 }),
      onStatus: (s) => statuses.push(s),
    });
    return {
      client,
      polls,
      events,
      statuses,
      open: () => open,
      advance: (ms: number) => (now += ms),
      setState: (s: string) => (state = s),
    };
  }

  it("parks after IDLE_PARK_MS stopped and untouched, tells the log, and holds no poll", async () => {
    const h = idleHarness("stopped");
    h.client.start({});
    await vi.waitFor(() => expect(h.open()).toBe(1));
    h.advance(IDLE_PARK_MS - 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.client.isParked).toBe(false);
    h.advance(1000);
    await vi.waitFor(() => expect(h.client.isParked).toBe(true));
    await vi.waitFor(() => expect(h.open()).toBe(0));
    expect(h.statuses.at(-1)).toBe("parked");
    expect(h.events.some((b) => b.includes("stopped polling"))).toBe(true);
    const count = h.polls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.polls.length).toBe(count);
    h.client.stop();
  });

  it("Play rejoins with exactly one poll loop", async () => {
    const h = idleHarness("stopped");
    h.client.start({});
    h.advance(IDLE_PARK_MS);
    await vi.waitFor(() => expect(h.client.isParked).toBe(true));
    h.setState("playing");
    await vi.waitFor(() => expect(h.client.isParked).toBe(false));
    await vi.waitFor(() => expect(h.polls.at(-1)).toContain("state=playing"));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.open()).toBe(1);
    h.client.stop();
  });

  it("a human event rejoins; a playing player never parks", async () => {
    const h = idleHarness("stopped");
    h.client.start({});
    h.advance(IDLE_PARK_MS);
    await vi.waitFor(() => expect(h.client.isParked).toBe(true));
    h.client.log({ t: "edit", cycle: null, code: "s('bd')", chars: 7 });
    expect(h.client.isParked).toBe(false);
    h.client.stop();

    const playing = idleHarness("playing");
    playing.client.start({});
    await vi.waitFor(() => expect(playing.open()).toBe(1));
    playing.advance(IDLE_PARK_MS * 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(playing.client.isParked).toBe(false);
    playing.client.stop();
  });
});

describe("review fixes (live sessions, Kimi)", () => {
  it("an update replaced before it played is answered, not left 'unconfirmed'", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("next?after=0&cycle=1&cps=0.5&state=playing&wait=0");
    const first = h.call("update", { method: "POST", body: JSON.stringify({ code: "one", quantize: 8 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    void h.call("update", { method: "POST", body: JSON.stringify({ code: "two", quantize: 8 }) });
    const outcome = await (await first).json();
    expect(outcome.applied).toMatchObject({ rev: 1, ok: false, error: expect.stringContaining("replaced by your next update (rev 2)") });
  });

  it("the client keeps polling (its heartbeat) while a swap waits for its bar", async () => {
    let release!: () => void;
    const urls: string[] = [];
    let served = false;
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events")) return new Response("{}");
        urls.push(url);
        if (!served) {
          served = true;
          return new Response(JSON.stringify({ rev: 1, code: "x", quantize: 32, at: 0 }));
        }
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 0, cps: 0.5, state: "playing" }),
      apply: () => new Promise((resolve) => (release = () => resolve({ ok: true, cycle: 32 }))),
    });
    client.start({});
    // The apply is still waiting, yet the next poll is already out.
    await vi.waitFor(() => expect(urls.filter((u) => u.includes("after=1"))).toHaveLength(1));
    release();
    client.stop();
  });

  it("only small batches use keepalive (the 64 KiB cap throws)", async () => {
    const inits: RequestInit[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (_url: string, init?: RequestInit) => {
        inits.push(init!);
        return new Response("{}");
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 0, cps: 0.5, state: "playing" }),
      apply: async () => ({ ok: true, cycle: 0 }),
    });
    client.log({ t: "pass", cycle: 1 }, true);
    client.log({ t: "edit", cycle: 1, code: "x".repeat(60_000), chars: 60_000 }, true);
    await vi.waitFor(() => expect(inits).toHaveLength(2));
    expect(inits[0].keepalive).toBe(true);
    expect(inits[1].keepalive).toBe(false);
  });
});


describe("review fixes (live sessions, Codex)", () => {
  it("a worst-case log stays under one storage value (it reached 5.2 MB)", () => {
    const d = newSession(ID, 0);
    for (let i = 0; i < SESSION_MAX_EVENTS; i++) appendEvents(d, coerceEvents([{ t: "report", text: "\u0001".repeat(5000) }]), i);
    for (let i = 0; i < 4; i++) appendEvents(d, coerceEvents([{ t: "edit", code: "\u0001".repeat(70_000) }]), i);
    queuePattern(d, "\u0001".repeat(70_000), 1, 1);
    expect(sessionBytes(d)).toBeLessThanOrEqual(SESSION_MAX_BYTES);
    expect(d.events.length).toBeGreaterThan(0);
  });

  it("an applied update stays applied after the log trims it away", () => {
    const d = newSession(ID, 0);
    const p = queuePattern(d, "x", 1, 0);
    appendEvents(d, [{ t: "applied", rev: p.rev, ok: true, cycle: 4 }], 1);
    for (let i = 0; i < SESSION_MAX_EVENTS; i++) appendEvents(d, [{ t: "tap", cycle: i, x: 0, y: 0 }], 2);
    expect(d.events.some((e) => e.t === "applied")).toBe(false);
    expect(describeSession(d, 3)).toContain(`latest update (rev ${p.rev}) applied at cycle 4.0`);
  });

  it("holds at most a few polls open, releasing the oldest", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const released: number[] = [];
    for (let i = 0; i < MAX_POLL_WAITERS + 2; i++) {
      void h.call("next?after=0&state=playing").then((r) => released.push(r.status));
    }
    await vi.waitFor(() => expect(released).toEqual([204, 204]));
    expect((h.obj as any).pollWaiters.size).toBe(MAX_POLL_WAITERS);
  });

  it("an aborted poll lets go of its waiter at once", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const abort = new AbortController();
    const poll = h.obj.fetch(new Request("https://session/next?after=0&state=playing", { signal: abort.signal }));
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    expect((await poll).status).toBe(204);
    expect((h.obj as any).pollWaiters.size).toBe(0);
  });

  it("splices settle once their boundary is past, so swaps never chain", () => {
    let p: any = sequence("a");
    for (let i = 0; i < 12; i++) p = spliceAt(p, sequence(`b${i}`), i + 1, stack, i + 0.5);
    // Each splice settled the previous one: one level of history, not twelve.
    const settled = settle(p, 100);
    expect(isSpliced(settled)).toBe(false);
    expect(settled.queryArc(20, 21)[0].value).toBe("b11");
    // Before its boundary, a splice still plays the old half.
    const fresh = spliceAt(sequence("old"), sequence("new"), 4, stack, 1);
    expect(settle(fresh, 3)).toBe(fresh);
    expect(fresh.queryArc(3, 4)[0].value).toBe("old");
    expect(fresh.queryArc(4, 5)[0].value).toBe("new");
  });
});

describe("listening — get-session(wait)", () => {
  it("holds until the listener passes, and the Pass is told a model is listening", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const read = h.call("state?wait=pass");
    await vi.waitFor(() => expect((h.obj as any).listeners.size).toBe(1));
    // Taps alone don't end a wait for Pass.
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "tap", cycle: 1, x: 0.5, y: 0.5 }] }) });
    expect((h.obj as any).listeners.size).toBe(1);
    const ack = await (await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "pass", cycle: 2 }] }) })).json();
    expect(ack.listening).toBe(true);
    const { text } = await (await read).json();
    expect(text).toContain("The listener passed the turn to you.");
    expect(text).toContain("the human tapped 1 time");
    // Nobody listening now.
    const later = await (await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "pass", cycle: 3 }] }) })).json();
    expect(later.listening).toBe(false);
  });

  it("returns at once if they already passed since the last read", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "pass", cycle: 2 }] }) });
    const { text } = await (await h.call("state?wait=pass")).json();
    expect(text).toContain("passed the turn to you");
  });

  it("'activity' waits a few seconds past the first move, then answers", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const read = h.call("state?wait=activity");
    await vi.waitFor(() => expect((h.obj as any).listeners.size).toBe(1));
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "control", name: "rain", kind: "fader", value: 0.7, cycle: 3 }] }) });
    await vi.waitFor(() => expect(h.sleeping()).toBeGreaterThanOrEqual(2)); // listen timeout + settle
    await h.advance(4_001);
    const { text } = await (await read).json();
    expect(text).toContain("The listener is playing:");
    expect(text).toContain("moved fader 'rain' to 0.7");
  });

  it("times out honestly", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const read = h.call("state?wait=pass&timeout=5000");
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await h.advance(5_001);
    const { text } = await (await read).json();
    expect(text).toContain("Still listening — the listener did nothing that passes the turn for 5 s.");
  });

  it("a poll hears that the model is listening", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const poll = h.call("next?after=0&state=playing");
    await new Promise((r) => setTimeout(r, 0));
    void h.call("state?wait=pass");
    const res = await poll;
    expect(res.status).toBe(204);
    expect(res.headers.get("x-session-listening")).toBe("1");
  });
});

describe("sensors in the session log", () => {
  it("says who is playing a sensor control, and folds device moves", () => {
    const data = newSession(ID, 0);
    appendEvents(
      data,
      coerceEvents([
        { t: "controls", list: [{ name: "tilt", kind: "xy", value: [0.5, 0.5], sensor: "tilt", source: "sensor" }, { name: "mic", kind: "fader", value: 0, min: 0, max: 1, sensor: "mic", source: "manual" }] },
        { t: "control", name: "tilt", kind: "xy", value: [0.8, 0.4], cycle: 2, source: "sensor" },
        { t: "control", name: "tilt", kind: "xy", value: [0.9, 0.3], cycle: 3, source: "sensor" },
      ]),
      1,
    );
    const text = describeSession(data, 2);
    expect(text).toContain("tilt (tilt: x left→right, y) x 0.90, y 0.30, played by the device");
    expect(text).toContain("mic (mic loudness 0–1) 0, played by hand — the sensor isn't available");
    expect(text).toContain("- the device moved xy 'tilt' 2 times, ending at x 0.90, y 0.30 (cycles 2.0–3.0).");
  });
});


describe("review fixes (0.9, Codex + Kimi)", () => {
  it("a session opens with its seed, so a second screen has the piece", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST", body: JSON.stringify({ seed: 's("bd*4")' }) });
    expect(await (await h.call("current")).json()).toMatchObject({ code: 's("bd*4")', source: "seed", rev: 0 });
    await h.call("update", { method: "POST", body: JSON.stringify({ code: "s('hh*8')" }) });
    expect(await (await h.call("current")).json()).toMatchObject({ code: "s('hh*8')", source: "update", rev: 1 });
  });

  it("a cancelled listen leaves the events unread", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    const abort = new AbortController();
    const listening = h.obj.fetch(new Request("https://session/state?wait=pass", { signal: abort.signal }));
    await vi.waitFor(() => expect((h.obj as any).listeners.size).toBe(1));
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "tap", cycle: 1, x: 0.5, y: 0.5 }] }) });
    abort.abort();
    expect((await listening).status).toBe(499);
    expect((await (await h.call("state")).json()).text).toContain("the human tapped 1 time");
  });

  it("holds at most MAX_LISTENERS listens; extras answer at once", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    for (let i = 0; i < MAX_LISTENERS; i++) void h.call("state?wait=pass");
    await vi.waitFor(() => expect((h.obj as any).listeners.size).toBe(MAX_LISTENERS));
    const extra = await h.call("state?wait=pass");
    expect(extra.status).toBe(200);
    expect((h.obj as any).listeners.size).toBe(MAX_LISTENERS);
  });

  it("a joined player starts after the rev its page already shows", async () => {
    const urls: string[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/events")) return new Response("{}");
        urls.push(url);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 0, cps: 0.5, state: "stopped" }),
      apply: async () => ({ ok: true, cycle: 0 }),
    }, 3);
    client.start({});
    await vi.waitFor(() => expect(urls[0]).toContain("after=3"));
    client.stop();
  });
});

describe("swapOutcome: a swap only succeeds if it actually took over", () => {
  const replaced = { ok: false, cycle: null, error: "replaced" };
  const base = { refused: false, ran: true, started: true, error: null, cancelled: null, cycle: 4, replaced };
  it("a clean run took over at its boundary", () => {
    expect(swapOutcome(base)).toEqual({ ok: true, cycle: 4, report: undefined });
  });
  it("stopped during its evaluation (a cancel stops what it started) is NOT a success (Codex review)", () => {
    expect(swapOutcome({ ...base, started: false })).toEqual({ ok: false, cycle: null, error: "the player was stopped before this swap took over" });
    expect(swapOutcome({ ...base, started: false, cancelled: "replaced by stop" }).error).toBe("replaced by stop");
  });
  it("refusal, a run that never started, and an eval error win in that order", () => {
    expect(swapOutcome({ ...base, refused: true, ran: false, error: "x" })).toBe(replaced);
    expect(swapOutcome({ ...base, ran: false, error: "x" }).error).toContain("taken over by a newer run");
    expect(swapOutcome({ ...base, error: "boom", started: false }).error).toBe("boom");
  });
});

describe("End session (the listener closes the set)", () => {
  async function open() {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    return h;
  }
  const end = (h: ReturnType<typeof harness>, cycle: unknown = 12.5) =>
    h.call("end", { method: "POST", body: JSON.stringify({ cycle }) });

  it("wakes a listening get-session at once, which reads that it ended", async () => {
    const h = await open();
    const listening = h.call("state?wait=pass");
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    expect(await (await end(h)).json()).toMatchObject({ ok: true, ended: true });
    const { text } = await (await listening).json();
    expect(text).toContain("The listener ended the session.");
    expect(text).toContain("ENDED this session");
    expect(text).toContain("(at cycle 12.5)");
    expect(text).toContain("- cycle 12.5: the listener ended the session.");
  });

  it("fails an update still waiting for the player's answer", async () => {
    const h = await open();
    await h.call("next?after=0&cycle=1&cps=0.5&state=playing&wait=0");
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: "s('bd')", quantize: 8 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await end(h);
    const outcome = await (await update).json();
    expect(outcome.applied).toMatchObject({ ok: false, error: "the listener ended the session" });
  });

  it("releases a held poll with 410, then answers polls, events, current and update 410", async () => {
    const h = await open();
    const poll = h.call("next?after=0&cycle=1&cps=0.5&state=playing");
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await end(h);
    expect((await poll).status).toBe(410);
    expect((await h.call("next?after=0")).status).toBe(410);
    expect((await h.call("events", { method: "POST", body: '{"events":[{"t":"pass"}]}' })).status).toBe(410);
    expect((await h.call("current")).status).toBe(410);
    expect((await h.call("update", { method: "POST", body: JSON.stringify({ code: "x" }) })).status).toBe(410);
    // A read (with or without wait) answers at once with the ended text: no new waiter.
    const before = h.sleeping();
    const { text } = await (await h.call("state?wait=pass")).json();
    expect(text).toContain("ENDED this session");
    expect(h.sleeping()).toBe(before);
  });

  it("is idempotent", async () => {
    const h = await open();
    await end(h, 3);
    expect(await (await end(h, 9)).json()).toMatchObject({ ok: true, already: true });
    const { text } = await (await h.call("state")).json();
    expect(text).toContain("(at cycle 3.0)");
    expect(text.match(/the listener ended the session/g)).toHaveLength(1);
  });

  it("deletes everything about 10 minutes after the end, not 2 hours", async () => {
    const h = await open();
    const t0 = 1_000_000;
    await end(h);
    expect(h.state.alarm()).toBe(t0 + SESSION_ENDED_TTL_MS);
    h.setNow(t0 + SESSION_ENDED_TTL_MS - 60_000);
    await h.obj.alarm(); // too early: re-arms
    expect(h.state.map.size).toBe(1);
    h.setNow(t0 + SESSION_ENDED_TTL_MS);
    await h.obj.alarm();
    expect(h.state.map.size).toBe(0);
    expect((await h.call("state")).status).toBe(404);
  });

  it("update-session says the listener ended it (not 'no such session')", async () => {
    const result = buildUpdateSessionResult(ID, "ended");
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("The listener ended this session");
    const b = httpSessionBackend(async () => new Response('{"error":"session ended"}', { status: 410 }));
    expect(await b.update(ID, "x", 1)).toBe("ended");
  });
});

describe("SessionClient.end", () => {
  it("sends what is queued, then the end, then stops polling", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const statuses: string[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body as string | undefined });
        if (url.includes("/next?")) {
          return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
        }
        return new Response('{"ok":true}');
      },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 7, cps: 0.5, state: "playing" }),
      apply: async () => ({ ok: true, cycle: 0 }),
      onStatus: (s) => statuses.push(s),
    });
    client.start({});
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/next?"))).toBe(true));
    client.log({ t: "tap", cycle: 6, x: 0.5, y: 0.5 }); // batched, not yet sent
    expect(await client.end(7.25)).toBe(true);
    const posts = calls.filter((c) => !c.url.includes("/next?"));
    expect(posts.at(-2)?.body).toContain('"t":"tap"');
    expect(posts.at(-1)).toMatchObject({ url: `https://example.test/session/${ID}/end`, body: '{"cycle":7.25}' });
    expect(statuses.at(-1)).toBe("ended");
    const count = calls.length;
    client.log({ t: "tap", cycle: 8, x: 0, y: 0 }, true);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(count); // nothing after the end
  });

  it("another screen's end (410 on a poll) shows as ended, quietly", async () => {
    const statuses: string[] = [];
    const client = new SessionClient("https://example.test", ID, {
      fetch: async (url: string) => (url.includes("/next?") ? new Response(null, { status: 410 }) : new Response("{}")),
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (h) => clearTimeout(h as any),
      clock: () => ({ cycle: 0, cps: 0.5, state: "playing" }),
      apply: async () => ({ ok: true, cycle: 0 }),
      onStatus: (s) => statuses.push(s),
    });
    client.start({});
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("ended"));
    expect(statuses).not.toContain("retrying");
  });
});

describe("field report fixes (0.10.1)", () => {
  it("update-session reports the bar the PLAYER picked, as soon as it is far away", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("next?after=0&cycle=36&cps=0.5&state=playing&wait=0");
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: "s('bd')", quantize: 8 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    // The player picked 48 (16 s away, beyond the 9 s wait): answer at once with it.
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "scheduled", rev: 1, boundary: 48 }] }) });
    const outcome = await (await update).json();
    expect(outcome.applied).toBeNull();
    expect(outcome.scheduled).toEqual({ boundary: 48 });
    const text = (buildUpdateSessionResult(ID, outcome).content[0] as any).text;
    expect(text).toContain("Rev 1 takes over at cycle 48.0");
    expect(text).toContain("the bar the player picked");
    const log = (await (await h.call("state")).json()).text;
    expect(log).toContain("scheduled by the player for cycle 48.0");
  });

  it("a NEAR scheduled bar keeps waiting for the real 'applied'", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("next?after=0&cycle=8&cps=0.5&state=playing&wait=0");
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: "s('bd')", quantize: 1 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "scheduled", rev: 1, boundary: 10 }] }) });
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "applied", rev: 1, ok: true, cycle: 10 }] }) });
    const outcome = await (await update).json();
    expect(outcome.applied).toMatchObject({ ok: true, cycle: 10 });
  });

  it("the update outcome carries the state of the check-in before the swap", async () => {
    const h = harness();
    await h.call(`init?id=${ID}`, { method: "POST" });
    await h.call("next?after=0&cycle=8&cps=0.5&state=playing&wait=0");
    const update = h.call("update", { method: "POST", body: JSON.stringify({ code: "s('bd')", quantize: 8 }) });
    await vi.waitFor(() => expect(h.sleeping()).toBe(1));
    await h.call("events", { method: "POST", body: JSON.stringify({ events: [{ t: "applied", rev: 1, ok: true, cycle: null }] }) });
    await h.advance(2000); // a stopped answer waits out STOPPED_ACK_GRACE_MS
    const outcome = await (await update).json();
    expect(outcome.widgetState).toBe("playing");
    expect(outcome.applied).toMatchObject({ ok: true, cycle: null });
  });

  it("a swap answered by a STOPPED player reads 'loaded', never 'cycle ?'", () => {
    const pattern = { rev: 2, code: "", quantize: 1, at: 0 };
    const res = buildUpdateSessionResult(ID, {
      pattern, applied: { seq: 1, at: 0, t: "applied", rev: 2, ok: true, cycle: null }, widgetSeenMsAgo: 1000, estCycle: 3, boundary: 4, cps: 0.5,
    });
    const text = (res.content[0] as any).text;
    expect(text).toContain("Rev 2 arrived while the player was stopped, so there is no landing bar: it is loaded in the player, which is stopped — it starts when Play is pressed");
    expect(text).not.toContain("?");
    expect(text).not.toContain("had reported");
    const data = newSession(ID, 0);
    queuePattern(data, "x", 1, 0);
    data.pattern!.rev = 1;
    appendEvents(data, [{ t: "applied", rev: 1, ok: true, cycle: null }, { t: "pass", cycle: null }, { t: "edit", cycle: null, code: "y", chars: 1 }], 1);
    const desc = describeSession(data, 2, 0);
    expect(desc).toContain("Your latest update (rev 1) is loaded in the player, which is stopped");
    expect(desc).toContain("- rev 1 arrived while the player was stopped, so no bar applied");
    expect(desc).toContain("while the player was stopped: the human passed the turn to you.");
    expect(desc).not.toMatch(/cycle \?/);
  });

  it("a stopped answer after a 'playing' check-in says the player stopped in between, and names no bar", () => {
    const pattern = { rev: 2, code: "", quantize: 8, at: 0 };
    const res = buildUpdateSessionResult(ID, {
      pattern, applied: { seq: 1, at: 0, t: "applied", rev: 2, ok: true, cycle: null },
      widgetSeenMsAgo: 6400, widgetState: "playing", estCycle: 12.8, boundary: 16, cps: 0.5,
    });
    const text = (res.content[0] as any).text;
    expect(text).toContain("there is no landing bar");
    expect(text).toContain('The player had reported "playing" 6 s before this update, so it stopped in between');
    expect(text).toContain("the screen locked");
    expect(text).not.toMatch(/cycle 16/);
  });

  it("a rev loaded while stopped reads as started once a later check-in says playing (field test 2026-10-03)", () => {
    const data = newSession(ID, 0);
    appendEvents(data, [{ t: "joined", host: "claude.ai" }], 1);
    queuePattern(data, "x", 0, 2);
    appendEvents(data, [{ t: "applied", rev: data.pattern!.rev, ok: true, cycle: null }], 1000);
    // Still stopped: the present tense is right.
    recordHeartbeat(data, { cycle: 0, cps: 0.5, state: "stopped" }, 1500);
    expect(describeSession(data, 2000, 0)).toContain("is loaded in the player, which is stopped — it starts when Play is pressed");
    // Play pressed: the header says playing, and the update line agrees.
    recordHeartbeat(data, { cycle: 2, cps: 0.5, state: "playing" }, 9000);
    let desc = describeSession(data, 10_000, 0);
    expect(desc).toContain("playing, around cycle 2.5");
    expect(desc).toContain("arrived while the player was stopped; Play has started it since — it is what is playing now.");
    expect(desc).not.toContain("which is stopped — it starts when Play is pressed");
    // A human edit after it: do not claim it is what is playing.
    appendEvents(data, [{ t: "edit", cycle: 3, code: "y", chars: 1 }], 9500);
    desc = describeSession(data, 10_000, 0);
    expect(desc).toContain("Play has started it since, and the human has run their own edit since (below).");
  });

  it("a 'playing' check-in older than one poll is not extrapolated: the player is probably suspended", () => {
    const data = newSession(ID, 0);
    appendEvents(data, [{ t: "joined", host: "claude.ai", platform: "mobile" }], 1);
    recordHeartbeat(data, { cycle: 10, cps: 0.5, state: "playing" }, 10_000);
    const fresh = describeSession(data, 10_000 + SESSION_HEARTBEAT_LATE_MS, 0);
    expect(fresh).toContain("playing, around cycle 25.0");
    const late = describeSession(data, 10_000 + SESSION_HEARTBEAT_LATE_MS + 5000, 0);
    expect(late).toContain("last reported playing 35 s ago (at cycle 10.0)");
    expect(late).toContain("probably suspended or stopped now");
    expect(late).not.toContain("around cycle");
    // A late check-in does not count as "Play has started it since".
    queuePattern(data, "x", 0, 2);
    appendEvents(data, [{ t: "applied", rev: data.pattern!.rev, ok: true, cycle: null }], 5000);
    expect(describeSession(data, 10_000 + SESSION_HEARTBEAT_LATE_MS + 5000, 0)).toContain("is loaded in the player, which is stopped");
    // Past the stale mark it is the old wording.
    expect(describeSession(data, 10_000 + SESSION_WIDGET_STALE_MS + 1, 0)).toContain("it may be closed, scrolled away or the app backgrounded");
  });

  it("names the widget version, warns when it is older than the service, and explains a missing function", () => {
    const data = newSession(ID, 0);
    appendEvents(data, [{ t: "joined", host: "claude.ai", widget: "0.10.1" }], 1);
    recordHeartbeat(data, { cycle: 1, cps: 0.5, state: "playing" }, 2);
    expect(describeSession(data, 3, 0, "0.10.1")).toContain("(widget 0.10.1, service 0.10.1)");
    expect(describeSession(data, 3, 0, "0.10.1")).not.toContain("OLDER widget");
    expect(describeSession(data, 3, 0, "0.11.0")).toContain("The player is an OLDER widget than this service");

    const old = newSession(ID, 0);
    appendEvents(old, [{ t: "joined", host: "claude.ai" }], 1);
    appendEvents(old, [{ t: "applied", rev: 1, ok: false, cycle: null, error: "tilt is not defined" }], 2);
    const text = describeSession(old, 3, 0, "0.10.1");
    expect(text).toContain("widget older than 0.10.1");
    expect(text).toContain("tilt() exists since widget 0.9.0, so this player is an OLDER widget");
    // A current widget with the same error is a real bug, not a stale cache.
    expect(staleWidgetHint("tilt is not defined", "0.10.1")).toBeNull();
    expect(staleWidgetHint("foo is not defined", null)).toBeNull();
    expect(coerceEvents([{ t: "joined", widget: "<script>" }])[0]).toMatchObject({ widget: undefined });
  });

  it("update-session's failure names the stale widget", () => {
    const res = buildUpdateSessionResult(ID, {
      pattern: { rev: 3, code: "", quantize: 1, at: 0 },
      applied: { seq: 1, at: 0, t: "applied", rev: 3, ok: false, cycle: null, error: "ReferenceError: mic is not defined" },
      widgetSeenMsAgo: 500, estCycle: 1, boundary: 2, cps: 0.5, widget: "0.8.0",
    });
    expect((res.content[0] as any).text).toContain("mic() exists since widget 0.9.0, so this player is an OLDER widget (version 0.8.0)");
  });
});
