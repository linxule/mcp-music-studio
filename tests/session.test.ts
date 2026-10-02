import { describe, expect, it, vi } from "vitest";
import { sequence, stack } from "@strudel/core";
import {
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
  SESSION_MAX_EDIT_BODIES,
  SESSION_MAX_EVENTS,
  type SessionData,
} from "../src/shared/session";
import { spliceAt, hapStart } from "../src/shared/splice";
import { JamSession, type SessionStorage } from "../worker/src/session-do";
import { SessionClient } from "../src/session-client";
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
    expect(outcome.boundary).toBe(9);
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
      "queued for cycle 12.0 (~4 s from now)",
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
