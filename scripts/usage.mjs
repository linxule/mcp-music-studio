#!/usr/bin/env node
// Read-only ops report for the Cloudflare account behind the hosted Worker.
// Run at each release: `bun run usage` (or `node scripts/usage.mjs --days 14 --json`).
// Sources: the GraphQL Analytics API (Workers AI, Worker invocations, Durable
// Objects), the public GET /tts/budget, and the Worker's Analytics Engine
// dataset via the SQL API. Pure shaping/rendering lives in lib/usage-format.mjs.
//
// The API token is read into memory only. Never print it or write it anywhere.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCRIPT_NAME,
  USAGE_HELP,
  isTokenShape,
  parseUsageArgs,
  redact,
  renderUsage,
  reportWindow,
  shapeAi,
  shapeAnalytics,
  shapeDurableObjects,
  shapeWorker,
} from "./lib/usage-format.mjs";

const API = "https://api.cloudflare.com/client/v4";
const BUDGET_URL = "https://music-studio.linxule.com/tts/budget";
const WRANGLER_CONFIG = path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
const LOGIN_HINT = process.env.CLOUDFLARE_API_TOKEN
  ? "CLOUDFLARE_API_TOKEN was refused: check it is valid and can read Account Analytics + Workers."
  : "Cloudflare login expired or missing: run `cd worker && bunx wrangler whoami` (refreshes it), then retry.";
const SHAPE_HINT = process.env.CLOUDFLARE_API_TOKEN
  ? "CLOUDFLARE_API_TOKEN is malformed (whitespace or non-ASCII characters, e.g. a pasted newline): set it again."
  : "The wrangler login token is malformed: run `cd worker && bunx wrangler login`, then retry.";
/** API error codes that mean "this token is no good" (malformed header, invalid or expired token). */
const AUTH_ERROR_CODES = new Set([6003, 6111, 9106, 9109, 10000]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class AuthError extends Error {}

/** Set once read, so every printed error can be scrubbed of it. */
let secret = null;
const clean = (message) => redact(message, secret);

function readToken() {
  const token = readRawToken();
  secret = token;
  if (!isTokenShape(token)) throw new AuthError(SHAPE_HINT);
  return token;
}

function readRawToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  let toml;
  try {
    toml = readFileSync(WRANGLER_CONFIG, "utf8");
  } catch {
    throw new AuthError(LOGIN_HINT);
  }
  const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const expires = /^expiration_time\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!token || (expires && Date.parse(expires) <= Date.now())) throw new AuthError(LOGIN_HINT);
  return token;
}

/** The dataset name from worker/wrangler.jsonc (binding ANALYTICS), so a rename can't drift. */
function analyticsDataset() {
  const text = readFileSync(path.join(root, "worker/wrangler.jsonc"), "utf8");
  return /"binding":\s*"ANALYTICS",\s*"dataset":\s*"([^"]+)"/.exec(text)?.[1] ?? "music_studio_usage";
}

async function cf(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  if (res.status === 401 || res.status === 403) throw new AuthError(LOGIN_HINT);
  return res;
}

async function accountId(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const body = await (await cf(token, `${API}/accounts?per_page=50`)).json();
  if (!body.success) {
    if (body.errors?.some((e) => AUTH_ERROR_CODES.has(e.code))) throw new AuthError(LOGIN_HINT);
    throw new Error(`listing accounts failed: ${JSON.stringify(body.errors)}`);
  }
  if (body.result.length !== 1) throw new Error(`the login sees ${body.result.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
  return body.result[0].id;
}

async function graphql(token, query, variables) {
  const res = await cf(token, `${API}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    if (/authenticat|authoriz|access token/i.test(msg)) throw new AuthError(LOGIN_HINT);
    throw new Error(msg);
  }
  return body.data.viewer.accounts[0];
}

const AI_QUERY = `query ($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    aiInferenceAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_lt: $end}, orderBy: [date_ASC]) {
      count
      dimensions { date modelId costMetricName1 }
      sum { totalNeurons totalCostMetricValue1 }
    }
  } }
}`;

const WORKER_QUERY = `query ($account: string!, $start: Time!, $end: Time!, $script: string!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 10000, filter: {scriptName: $script, datetime_geq: $start, datetime_lt: $end}, orderBy: [date_ASC]) {
      dimensions { date }
      sum { requests errors duration }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
  } }
}`;

const DO_QUERY = `query ($account: string!, $start: Time!, $end: Time!, $filter: AccountDurableObjectsPeriodicGroupsFilter_InputObject!) {
  viewer { accounts(filter: {accountTag: $account}) {
    durableObjectsPeriodicGroups(limit: 10000, filter: {AND: [{datetime_geq: $start, datetime_lt: $end}, $filter]}, orderBy: [date_ASC]) {
      dimensions { date namespaceId }
      sum { activeTime duration }
    }
  } }
}`;

/** Namespace id → class for this script's Durable Objects (REST; GraphQL has no scriptName on this dataset). */
async function doNamespaces(token, account) {
  const body = await (await cf(token, `${API}/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`)).json();
  if (!body.success) throw new Error(JSON.stringify(body.errors));
  return Object.fromEntries(body.result.filter((n) => n.script === SCRIPT_NAME).map((n) => [n.id, n.class]));
}

async function analyticsSql(token, account, dataset, start) {
  const since = start.replace("T", " ").slice(0, 19);
  const sql = `SELECT formatDateTime(timestamp, '%Y-%m-%d') AS day, blob1, blob2,
    SUM(_sample_interval) AS n, SUM(_sample_interval * double1) AS chars
    FROM ${dataset}
    WHERE timestamp >= toDateTime('${since}') AND blob1 IN ('tts', 'session', 'tool_call')
    GROUP BY day, blob1, blob2 FORMAT JSON`;
  const res = await cf(token, `${API}/accounts/${account}/analytics_engine/sql`, { method: "POST", body: sql });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL API ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).data;
}

/** Runs one section; a failure becomes `{error}` in the report instead of sinking the rest. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { error: clean(err?.message) };
  }
}

async function main() {
  let opts;
  try {
    opts = parseUsageArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE_HELP}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE_HELP);
    return;
  }

  const win = reportWindow(opts.days);
  const notes = [];
  let token, account;
  try {
    token = readToken();
    account = await accountId(token);
  } catch (err) {
    console.error(clean(err?.message));
    process.exit(err instanceof AuthError ? 2 : 1);
  }
  const vars = { account, start: win.start, end: win.end };
  const dataset = analyticsDataset();

  let report;
  try {
    const [workersAi, worker, durableObjects, voiceBudget, analyticsEngine] = await Promise.all([
      attempt(async () => shapeAi(win.dates, (await graphql(token, AI_QUERY, vars)).aiInferenceAdaptiveGroups)),
      attempt(async () => shapeWorker(win.dates, (await graphql(token, WORKER_QUERY, { ...vars, script: SCRIPT_NAME })).workersInvocationsAdaptive)),
      attempt(async () => {
        let classes = {};
        let filter = {};
        let scope = `${SCRIPT_NAME} namespaces`;
        try {
          classes = await doNamespaces(token, account);
          if (!Object.keys(classes).length) throw new Error(`no namespaces belong to ${SCRIPT_NAME}`);
          filter = { namespaceId_in: Object.keys(classes) };
        } catch (err) {
          if (err instanceof AuthError) throw err;
          classes = {};
          scope = "whole account (namespace lookup failed)";
          notes.push(`Durable Object namespaces could not be listed (${clean(err?.message)}); the DO table is account-wide.`);
        }
        const rows = (await graphql(token, DO_QUERY, { ...vars, filter })).durableObjectsPeriodicGroups;
        return { scope, ...shapeDurableObjects(win.dates, rows, classes) };
      }),
      attempt(async () => {
        const res = await fetch(BUDGET_URL, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`${BUDGET_URL} → ${res.status}`);
        return res.json();
      }),
      attempt(async () => ({ dataset, ...shapeAnalytics(win.dates, await analyticsSql(token, account, dataset, win.start)) })),
    ]);
    report = { window: win, workersAi, worker, durableObjects, voiceBudget, analyticsEngine, notes };
  } catch (err) {
    console.error(clean(err?.message));
    process.exit(err instanceof AuthError ? 2 : 1);
  }

  notes.push(
    "Workers AI rows are account-wide: voice calls can include the lab Worker and local `wrangler dev` runs, and the 10k-neuron daily allowance is shared by every Worker. Production cache misses are the Analytics Engine 'tts miss' column, which includes 'prerender' (lines a tool call rendered ahead of the player).",
    "GB-s is Cloudflare's billed duration; an awake JamSession is 128 MB, so 1 active hour ≈ 461 GB-s.",
    "Analytics Engine counts are sampled estimates (SUM(_sample_interval)); 'miss chars' are new characters sent to the voice model.",
  );
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderUsage(report));
}

try {
  await main();
} catch (err) {
  console.error(clean(err?.message));
  process.exit(1);
}
