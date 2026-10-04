import { describe, expect, it } from "vitest";
import {
  MAX_DAYS,
  VOICE_MODEL,
  isTokenShape,
  parseUsageArgs,
  redact,
  renderUsage,
  reportWindow,
  shapeAi,
  shapeAnalytics,
  shapeDurableObjects,
  shapeWorker,
  table,
  wranglerConfigCandidates,
} from "../scripts/lib/usage-format.mjs";

const dates = ["2026-10-03", "2026-10-04"];

describe("parseUsageArgs", () => {
  it("defaults to 7 days of tables", () => {
    expect(parseUsageArgs([])).toEqual({ days: 7, json: false, help: false });
  });
  it("reads --days N, --days=N, --json and --help", () => {
    expect(parseUsageArgs(["--days", "14", "--json"])).toMatchObject({ days: 14, json: true });
    expect(parseUsageArgs(["--days=3"]).days).toBe(3);
    expect(parseUsageArgs(["-h"]).help).toBe(true);
  });
  it("refuses days outside what the GraphQL datasets keep, and unknown flags", () => {
    expect(() => parseUsageArgs(["--days", "0"])).toThrow(/1 to 31/);
    expect(() => parseUsageArgs(["--days", String(MAX_DAYS + 1)])).toThrow();
    expect(() => parseUsageArgs(["--days", "2.5"])).toThrow();
    expect(() => parseUsageArgs(["--days"])).toThrow(/got nothing/);
    expect(() => parseUsageArgs(["--weeks"])).toThrow(/unknown argument/);
  });
});

describe("reportWindow", () => {
  it("covers whole UTC days up to now, today included", () => {
    const w = reportWindow(3, new Date("2026-10-04T18:22:00Z"));
    expect(w.dates).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(w.start).toBe("2026-10-02T00:00:00.000Z");
    expect(w.end).toBe("2026-10-04T18:22:00.000Z");
  });
});

describe("shapeAi", () => {
  it("separates the voice model, reads its characters from cost metric 1, and fills empty days", () => {
    const ai = shapeAi(dates, [
      { count: 1, dimensions: { date: "2026-10-04", modelId: VOICE_MODEL, costMetricName1: "input_characters" }, sum: { totalNeurons: 62.7, totalCostMetricValue1: 23 } },
      { count: 3, dimensions: { date: "2026-10-04", modelId: "@cf/meta/llama", costMetricName1: "" }, sum: { totalNeurons: 184, totalCostMetricValue1: 999 } },
    ]);
    expect(ai.days[0]).toMatchObject({ date: "2026-10-03", voiceRequests: 0, allNeurons: 0 });
    expect(ai.days[1]).toMatchObject({ voiceRequests: 1, voiceChars: 23, allRequests: 4 });
    expect(ai.days[1].voiceListUsd).toBeCloseTo(0.00069);
    expect(ai.days[1].freeShare).toBeCloseTo(0.02467);
    expect(ai.models.map((m) => m.model)).toEqual(["@cf/meta/llama", VOICE_MODEL]);
  });
});

describe("shapeWorker", () => {
  it("sums per day and turns CPU quantiles into milliseconds", () => {
    const w = shapeWorker(dates, [
      { dimensions: { date: "2026-10-04" }, sum: { requests: 9169, errors: 1, duration: 443 }, quantiles: { cpuTimeP50: 8012, cpuTimeP99: 95142 } },
    ]);
    expect(w[0]).toMatchObject({ requests: 0, cpuP50Ms: null });
    expect(w[1]).toMatchObject({ requests: 9169, errors: 1, gbSeconds: 443, cpuP50Ms: 8.012, cpuP99Ms: 95.142 });
  });
});

describe("shapeDurableObjects", () => {
  it("names columns by class and converts activeTime microseconds to hours", () => {
    const dob = shapeDurableObjects(dates, [{ dimensions: { date: "2026-10-03", namespaceId: "ns1" }, sum: { activeTime: 3.6e9, duration: 460.8 } }], {
      ns1: "JamSession",
      ns2: "VoiceBudget",
    });
    expect(dob.classes).toEqual(["JamSession", "VoiceBudget"]);
    expect(dob.days[0].byClass.JamSession).toEqual({ activeHours: 1, gbSeconds: 460.8 });
  });
  it("falls back to one account-wide column when no namespaces are known", () => {
    const dob = shapeDurableObjects(dates, [{ dimensions: { date: "2026-10-04", namespaceId: "x" }, sum: { activeTime: 1.8e9, duration: 1 } }], {});
    expect(dob.classes).toEqual(["other"]);
    expect(dob.days[1].byClass.other.activeHours).toBe(0.5);
  });
});

describe("shapeAnalytics", () => {
  it("reads the Worker's track() layout and folds scanner probe names into one row", () => {
    const ae = shapeAnalytics(dates, [
      { day: "2026-10-04", blob1: "tts", blob2: "miss", n: "43", chars: 816 },
      { day: "2026-10-04", blob1: "tts", blob2: "hit", n: "7", chars: 110 },
      { day: "2026-10-04", blob1: "tts", blob2: "budget", n: "2", chars: 40 },
      { day: "2026-10-03", blob1: "session", blob2: "new", n: "8", chars: 0 },
      { day: "2026-10-03", blob1: "session", blob2: "limited", n: "1", chars: 0 },
      { day: "2026-10-03", blob1: "tool_call", blob2: "play-live-pattern", n: "5", chars: 0 },
      { day: "2026-10-03", blob1: "tool_call", blob2: "__verifymcp_auth_probe_ab12__", n: "1", chars: 0 },
      { day: "2026-10-04", blob1: "tool_call", blob2: "__mcpcheckup_probe_nonexistent_tool__", n: "2", chars: 0 },
      { day: "2026-09-01", blob1: "session", blob2: "new", n: "99", chars: 0 },
    ]);
    expect(ae.days[0]).toMatchObject({ sessionsNew: 8, sessionsLimited: 1, toolCalls: 6 });
    expect(ae.days[1]).toMatchObject({ ttsMiss: 43, ttsMissChars: 816, ttsHit: 7, ttsRefused: 2, toolCalls: 2 });
    expect(ae.tools).toEqual([
      { tool: "play-live-pattern", calls: 5 },
      { tool: "(probe names __…__)", calls: 3 },
    ]);
  });
});

describe("shapeAnalytics — tool-time prerender", () => {
  // A prerender miss is a model call like any other: hiding it would hide
  // production voice usage (review finding).
  const rows = [
    { day: "2026-10-04", blob1: "tts", blob2: "miss", n: "10", chars: 200 },
    { day: "2026-10-04", blob1: "tts", blob2: "prerender-miss", n: "6", chars: 90 },
    { day: "2026-10-04", blob1: "tts", blob2: "prerender-hit", n: "4", chars: 60 },
    { day: "2026-10-04", blob1: "tts", blob2: "prerender-skipped", n: "1", chars: 1 },
    { day: "2026-10-04", blob1: "tts", blob2: "inflight-timeout", n: "1", chars: 9 },
    { day: "2026-10-04", blob1: "tts", blob2: "hit", n: "12", chars: 300 },
  ];
  it("counts prerender misses in tts miss / miss chars and in their own prerender column", () => {
    const ae = shapeAnalytics(dates, rows);
    expect(ae.days[1]).toMatchObject({ ttsMiss: 16, ttsMissChars: 290, ttsPrerender: 6, ttsPrerenderChars: 90, ttsHit: 12, ttsInflightTimeout: 1 });
  });
  it("prints the prerender column", () => {
    const text = renderUsage({
      window: { start: "", end: "", dates },
      workersAi: { error: "x" },
      worker: { error: "x" },
      durableObjects: { error: "x" },
      voiceBudget: { error: "x" },
      analyticsEngine: { dataset: "music_studio_usage", ...shapeAnalytics(dates, rows) },
      notes: [],
    });
    expect(text).toMatch(/tts hit\s+tts miss\s+miss chars\s+prerender\s+refused/);
    expect(text).toMatch(/2026-10-04\s+0\s+0\s+12\s+16\s+290\s+6\s+0/);
  });
});

describe("the credential never reaches the output", () => {
  const token = "AbC123-xyz_TOKEN-value.0987";
  it("accepts printable ASCII, refuses whitespace and non-ASCII", () => {
    expect(isTokenShape(token)).toBe(true);
    expect(isTokenShape(`${token}\n`)).toBe(false);
    expect(isTokenShape(`abc def`)).toBe(false);
    expect(isTokenShape(`tökén`)).toBe(false);
    expect(isTokenShape("")).toBe(false);
    expect(isTokenShape(undefined)).toBe(false);
  });
  it("redacts the token and anything after Bearer", () => {
    // What fetch throws for a token with a newline in it.
    const broken = `${token}\nmore`;
    const msg = `Header 'Authorization' has invalid value: 'Bearer ${broken}'`;
    const out = redact(msg, broken);
    expect(out).not.toContain(token);
    expect(out).not.toContain("more");
    expect(out).toBe("Header 'Authorization' has invalid value: 'Bearer [redacted]");
    expect(redact(`SQL API 400: echoed ${token} back`, token)).toBe("SQL API 400: echoed [redacted] back");
    expect(redact("listing accounts failed: []", null)).toBe("listing accounts failed: []");
    expect(redact(undefined, token)).toBe("undefined");
  });
});

describe("rendering", () => {
  it("aligns a table: first column left, numbers right", () => {
    expect(table(["date", "n"], [["2026-10-04", "1,234"], ["total", "5"]])).toBe(
      ["date            n", "----------  -----", "2026-10-04  1,234", "total           5"].join("\n"),
    );
  });
  it("prints every section, and a failed one as unavailable instead of throwing", () => {
    const text = renderUsage({
      window: { start: "", end: "", dates },
      workersAi: shapeAi(dates, []),
      worker: { error: "boom" },
      durableObjects: { scope: "mcp-music-studio namespaces", ...shapeDurableObjects(dates, [], { a: "JamSession" }) },
      voiceBudget: { month: "2026-10", spentUsd: 0.0007, budgetUsd: 10, today: "2026-10-04", spentTodayUsd: 0.0007, todayCapUsd: 1 },
      analyticsEngine: { dataset: "music_studio_usage", ...shapeAnalytics(dates, []) },
      notes: ["a note"],
    });
    expect(text).toContain("## Workers AI");
    expect(text).toMatch(/## Worker mcp-music-studio — invocations\nunavailable: boom/);
    expect(text).toContain("JamSession active h");
    expect(text).toMatch(/month 2026-10\s+\$0\.0007\s+\$10\.00\s+0%/);
    expect(text).toContain("No tool calls in this window.");
    expect(text).toContain("- a note");
  });
});

describe("wranglerConfigCandidates", () => {
  const tail = ".wrangler/config/default.toml";
  it("macOS: legacy ~/.wrangler, then Library/Preferences", () => {
    expect(wranglerConfigCandidates({ home: "/Users/a", platform: "darwin" })).toEqual([
      `/Users/a/${tail}`,
      `/Users/a/Library/Preferences/${tail}`,
    ]);
  });
  it("Linux: legacy, then $XDG_CONFIG_HOME, then ~/.config", () => {
    expect(wranglerConfigCandidates({ home: "/home/a", env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux" })).toEqual([
      `/home/a/${tail}`,
      `/xdg/${tail}`,
      `/home/a/.config/${tail}`,
    ]);
    expect(wranglerConfigCandidates({ home: "/home/a", env: {}, platform: "linux" })).toEqual([
      `/home/a/${tail}`,
      `/home/a/.config/${tail}`,
    ]);
  });
  it("Windows: %APPDATA%/xdg.config; an XDG dir equal to the default isn't listed twice", () => {
    expect(wranglerConfigCandidates({ home: "C:/u", env: { APPDATA: "C:/u/AD" }, platform: "win32" })).toEqual([
      `C:/u/${tail}`,
      `C:/u/AD/xdg.config/${tail}`,
    ]);
    expect(wranglerConfigCandidates({ home: "/home/a", env: { XDG_CONFIG_HOME: "/home/a/.config" }, platform: "linux" })).toHaveLength(2);
  });
});
