// Pure helpers for scripts/usage.mjs: argument parsing, the report window,
// shaping Cloudflare's rows into per-day tables, and plain-text rendering.
// No I/O here, so tests/usage-format.test.ts can drive it with fixtures.

export const VOICE_MODEL = "@cf/deepgram/aura-2-en";
export const SCRIPT_NAME = "mcp-music-studio";
/** Aura-2 list price per character (Workers AI pricing: $0.030 per 1k characters). */
export const VOICE_USD_PER_CHAR = 0.00003;
/** Workers AI free allowance, per account per UTC day (both plans). */
export const FREE_NEURONS_PER_DAY = 10_000;
/** The GraphQL adaptive datasets answer at most 32 days back (settings.maxDuration). */
export const MAX_DAYS = 31;

export const USAGE_HELP = `Usage: node scripts/usage.mjs [--days N] [--json]

Read-only ops report for the Cloudflare account behind the Worker "${SCRIPT_NAME}":
Workers AI by model, Worker invocations, Durable Object time, the voice budget
(GET /tts/budget) and the Worker's Analytics Engine counters, per UTC day.

  --days N   days to cover, today included (1-${MAX_DAYS}, default 7)
  --json     print the report as JSON instead of tables
  --help     show this text

Auth: CLOUDFLARE_API_TOKEN if set (needs Account Analytics read + Workers read),
otherwise wrangler's own login. If that has expired, run \`cd worker && bunx wrangler whoami\`.
CLOUDFLARE_ACCOUNT_ID picks the account when the login sees more than one.`;

export function parseUsageArgs(argv) {
  const opts = { days: 7, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      const raw = arg === "--days" ? argv[++i] : arg.slice("--days=".length);
      const days = Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS} (got ${raw ?? "nothing"})`);
      }
      opts.days = days;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** The last `days` UTC days, today included: [start, now) plus each date label. */
export function reportWindow(days, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = today - (days - 1) * 86_400_000;
  const dates = Array.from({ length: days }, (_, i) => new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
  return { start: new Date(startMs).toISOString(), end: now.toISOString(), dates };
}

const num = (v) => (v == null || v === "" ? 0 : Number(v));

/**
 * Workers AI rows ({dimensions:{date, modelId, costMetricName1}, count, sum:{totalNeurons,
 * totalCostMetricValue1}}) → per day + per model. Aura-2 reports its characters as cost
 * metric 1 ("input_characters"); totalInputLength stays 0 for it.
 */
export function shapeAi(dates, groups) {
  const byDay = new Map(dates.map((d) => [d, { date: d, voiceRequests: 0, voiceNeurons: 0, voiceChars: 0, allRequests: 0, allNeurons: 0 }]));
  const byModel = new Map();
  for (const g of groups) {
    const day = byDay.get(g.dimensions.date);
    const model = g.dimensions.modelId || "(unknown)";
    const requests = num(g.count);
    const neurons = num(g.sum?.totalNeurons);
    if (day) {
      day.allRequests += requests;
      day.allNeurons += neurons;
      if (model === VOICE_MODEL) {
        day.voiceRequests += requests;
        day.voiceNeurons += neurons;
        if (g.dimensions.costMetricName1 === "input_characters") day.voiceChars += num(g.sum?.totalCostMetricValue1);
      }
    }
    const m = byModel.get(model) ?? { model, requests: 0, neurons: 0 };
    m.requests += requests;
    m.neurons += neurons;
    byModel.set(model, m);
  }
  for (const day of byDay.values()) {
    day.voiceListUsd = day.voiceChars * VOICE_USD_PER_CHAR;
    day.freeShare = day.allNeurons / FREE_NEURONS_PER_DAY;
  }
  return { days: [...byDay.values()], models: [...byModel.values()].sort((a, b) => b.neurons - a.neurons) };
}

/** workersInvocationsAdaptive rows grouped by date → requests, errors, CPU quantiles (ms). */
export function shapeWorker(dates, groups) {
  const byDay = new Map(dates.map((d) => [d, { date: d, requests: 0, errors: 0, cpuP50Ms: null, cpuP99Ms: null, gbSeconds: 0 }]));
  for (const g of groups) {
    const day = byDay.get(g.dimensions.date);
    if (!day) continue;
    day.requests += num(g.sum?.requests);
    day.errors += num(g.sum?.errors);
    day.gbSeconds += num(g.sum?.duration);
    if (g.quantiles) {
      day.cpuP50Ms = num(g.quantiles.cpuTimeP50) / 1000;
      day.cpuP99Ms = num(g.quantiles.cpuTimeP99) / 1000;
    }
  }
  return [...byDay.values()];
}

/**
 * durableObjectsPeriodicGroups rows grouped by date + namespaceId → per day, one
 * column pair per class. `classes` maps namespace id → class name; rows from
 * other namespaces are summed under "other" (account-wide fallback).
 */
export function shapeDurableObjects(dates, groups, classes) {
  const names = [...new Set(Object.values(classes))];
  const blank = () => Object.fromEntries([...names, "other"].map((n) => [n, { activeHours: 0, gbSeconds: 0 }]));
  const byDay = new Map(dates.map((d) => [d, { date: d, byClass: blank() }]));
  for (const g of groups) {
    const day = byDay.get(g.dimensions.date);
    if (!day) continue;
    const cls = classes[g.dimensions.namespaceId] ?? "other";
    day.byClass[cls].activeHours += num(g.sum?.activeTime) / 3.6e9; // microseconds → hours
    day.byClass[cls].gbSeconds += num(g.sum?.duration);
  }
  const days = [...byDay.values()];
  const hasOther = days.some((d) => d.byClass.other.activeHours || d.byClass.other.gbSeconds);
  return { classes: hasOther || !names.length ? [...names, "other"] : names, days };
}

/**
 * Analytics Engine rows ({day, blob1, blob2, n, chars}) → per day counters.
 * Layout (worker/src/index.ts `track`): blob1 = event family, blob2 = detail;
 * tts doubles[0] = characters; tool_call blob2 = tool name. A tool call warming
 * its say() lines logs `prerender-miss` (a model call like any miss, so it
 * counts in ttsMiss too), `prerender-hit` (already cached) and
 * `prerender-skipped`; `inflight-timeout` is a player that waited for another
 * render's clip and rendered the line itself.
 */
export function shapeAnalytics(dates, rows) {
  const byDay = new Map(
    dates.map((d) => [
      d,
      { date: d, sessionsNew: 0, sessionsLimited: 0, ttsHit: 0, ttsMiss: 0, ttsMissChars: 0, ttsPrerender: 0, ttsPrerenderChars: 0, ttsInflightTimeout: 0, ttsRefused: 0, toolCalls: 0 },
    ]),
  );
  const tools = new Map();
  for (const r of rows) {
    const day = byDay.get(r.day);
    if (!day) continue;
    const n = num(r.n);
    if (r.blob1 === "session" && r.blob2 === "new") day.sessionsNew += n;
    else if (r.blob1 === "session" && r.blob2 === "limited") day.sessionsLimited += n;
    else if (r.blob1 === "tts" && r.blob2 === "hit") day.ttsHit += n;
    else if (r.blob1 === "tts" && (r.blob2 === "miss" || r.blob2 === "prerender-miss")) {
      day.ttsMiss += n;
      day.ttsMissChars += num(r.chars);
      if (r.blob2 === "prerender-miss") {
        day.ttsPrerender += n;
        day.ttsPrerenderChars += num(r.chars);
      }
    } else if (r.blob1 === "tts" && r.blob2 === "inflight-timeout") day.ttsInflightTimeout += n;
    else if (r.blob1 === "tts" && r.blob2 === "budget") day.ttsRefused += n;
    else if (r.blob1 === "tool_call") {
      day.toolCalls += n;
      // Scanners call made-up names like __verifymcp_auth_probe_<hex>__; one row for all of them.
      const tool = /^__.*__$/.test(r.blob2) ? "(probe names __…__)" : r.blob2 || "(none)";
      tools.set(tool, (tools.get(tool) ?? 0) + n);
    }
  }
  return {
    days: [...byDay.values()],
    tools: [...tools].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls),
  };
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

/**
 * A bearer token is printable ASCII without spaces. Anything else (a pasted
 * newline, say) makes fetch throw an error that quotes the whole header — so it
 * is refused before use.
 */
export const isTokenShape = (token) => typeof token === "string" && /^[\x21-\x7e]+$/.test(token);

/** An error message safe to print: the token and anything after "Bearer" are removed. */
export function redact(message, token) {
  let text = String(message);
  if (token) text = text.split(token).join("[redacted]");
  return text.replace(/Bearer[\s\S]*/gi, "Bearer [redacted]");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const fmtInt = (n) => (n == null ? "–" : Math.round(n).toLocaleString("en-US"));
export const fmtNum = (n, digits = 1) =>
  n == null ? "–" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtPct = (share) => (share == null ? "–" : `${Math.round(share * 100)}%`);
export const fmtUsd = (n) => (n == null ? "–" : `$${n.toFixed(4).replace(/0{1,2}$/, "")}`);

/** A monospace table: first column left-aligned, the rest right-aligned. */
export function table(headers, rows) {
  const cells = [headers, ...rows].map((r) => headers.map((_, i) => String(r[i] ?? "")));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd();
  return [line(cells[0]), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

/** Column sums; a null entry leaves that column blank. */
function totalsRow(label, days, keys) {
  return [label, ...keys.map((k) => (k ? k[1](days.reduce((s, d) => s + (d[k[0]] ?? 0), 0)) : ""))];
}

/** The whole report as text. Sections that failed carry `{error}` and print it. */
export function renderUsage(report) {
  const out = [`mcp-music-studio usage — ${report.window.dates[0]} → ${report.window.dates.at(-1)} (UTC, ${report.window.dates.length} days; today is partial)`];
  const section = (title, body) => out.push("", `## ${title}`, body);
  const failed = (s) => (s?.error ? `unavailable: ${s.error}` : null);

  const ai = report.workersAi;
  section(
    `Workers AI — voice model ${VOICE_MODEL} (free allowance is account-wide)`,
    failed(ai) ??
      [
        table(
          ["date", "voice calls", "voice chars", "voice list $", "voice neurons", "all neurons", "of 10k free"],
          [
            ...ai.days.map((d) => [d.date, fmtInt(d.voiceRequests), fmtInt(d.voiceChars), fmtUsd(d.voiceListUsd), fmtInt(d.voiceNeurons), fmtInt(d.allNeurons), fmtPct(d.freeShare)]),
            totalsRow("total", ai.days, [["voiceRequests", fmtInt], ["voiceChars", fmtInt], ["voiceListUsd", fmtUsd], ["voiceNeurons", fmtInt], ["allNeurons", fmtInt], null]),
          ],
        ),
        "",
        ai.models.length
          ? table(["model (whole account)", "calls", "neurons"], ai.models.map((m) => [m.model, fmtInt(m.requests), fmtInt(m.neurons)]))
          : "No Workers AI calls on the account in this window.",
      ].join("\n"),
  );

  const w = report.worker;
  section(
    `Worker ${SCRIPT_NAME} — invocations`,
    failed(w) ??
      table(
        ["date", "requests", "errors", "CPU p50 ms", "CPU p99 ms", "GB-s"],
        [
          ...w.map((d) => [d.date, fmtInt(d.requests), fmtInt(d.errors), fmtNum(d.cpuP50Ms), fmtNum(d.cpuP99Ms), fmtNum(d.gbSeconds, 0)]),
          totalsRow("total", w, [["requests", fmtInt], ["errors", fmtInt], null, null, ["gbSeconds", (n) => fmtNum(n, 0)]]),
        ],
      ),
  );

  const dob = report.durableObjects;
  if (dob?.error) section("Durable Objects", failed(dob));
  else {
    const headers = ["date", ...dob.classes.flatMap((c) => [`${c} active h`, `${c} GB-s`])];
    const rows = dob.days.map((d) => [d.date, ...dob.classes.flatMap((c) => [fmtNum(d.byClass[c].activeHours, 2), fmtNum(d.byClass[c].gbSeconds, 0)])]);
    const sum = (c, k) => dob.days.reduce((s, d) => s + d.byClass[c][k], 0);
    rows.push(["total", ...dob.classes.flatMap((c) => [fmtNum(sum(c, "activeHours"), 2), fmtNum(sum(c, "gbSeconds"), 0)])]);
    section(`Durable Objects — ${dob.scope}`, table(headers, rows));
  }

  const vb = report.voiceBudget;
  section(
    "Voice budget — GET /tts/budget",
    failed(vb) ??
      table(
        ["window", "spent", "budget", "used"],
        [
          [`month ${vb.month}`, fmtUsd(vb.spentUsd), fmtUsd(vb.budgetUsd), fmtPct(vb.budgetUsd ? vb.spentUsd / vb.budgetUsd : null)],
          [`today ${vb.today}`, fmtUsd(vb.spentTodayUsd), fmtUsd(vb.todayCapUsd), fmtPct(vb.todayCapUsd ? vb.spentTodayUsd / vb.todayCapUsd : null)],
        ],
      ),
  );

  const ae = report.analyticsEngine;
  section(
    `Analytics Engine — dataset ${ae?.dataset ?? "?"} (sampled counts)`,
    failed(ae) ??
      [
        table(
          ["date", "sessions", "limited", "tts hit", "tts miss", "miss chars", "prerender", "refused", "tool calls"],
          [
            ...ae.days.map((d) => [d.date, fmtInt(d.sessionsNew), fmtInt(d.sessionsLimited), fmtInt(d.ttsHit), fmtInt(d.ttsMiss), fmtInt(d.ttsMissChars), fmtInt(d.ttsPrerender), fmtInt(d.ttsRefused), fmtInt(d.toolCalls)]),
            totalsRow("total", ae.days, ["sessionsNew", "sessionsLimited", "ttsHit", "ttsMiss", "ttsMissChars", "ttsPrerender", "ttsRefused", "toolCalls"].map((k) => [k, fmtInt])),
          ],
        ),
        "",
        ae.tools.length ? table(["tool", "calls"], ae.tools.map((t) => [t.tool, fmtInt(t.calls)])) : "No tool calls in this window.",
      ].join("\n"),
  );

  if (report.notes?.length) out.push("", "Notes:", ...report.notes.map((n) => `- ${n}`));
  return out.join("\n");
}
