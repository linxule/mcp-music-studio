/**
 * The validation child: a process whose only job is to run model-written
 * Strudel and post back what it did.
 *
 * Nothing here is interesting except WHERE it runs. strudel-validate-host.ts
 * forks this file with `env: {}`, a harmless cwd, a 512 MB heap cap and
 * `stdio: ["ignore", "ignore", "pipe", "ipc"]` — so a pattern that reads
 * `process.env` finds nothing worth having, one that allocates forever dies
 * here instead of taking the MCP server with it, and one that prints to stdout
 * writes to /dev/null rather than into the server's JSON-RPC frame. The host
 * SIGKILLs this process on any timeout and forks a fresh one next time.
 *
 * Protocol, one request in flight at a time (the host serialises):
 *
 *   child → host   { type: "ready" }                     once, after warm-up
 *   host  → child  { id, code, cycles, timeoutMs }
 *   child → host   { id, result: StrudelValidation }
 *
 * Everything the child sends is plain JSON (fork's default serialisation), so
 * a pattern cannot hand the parent anything but data.
 */
import { validateStrudelInProcess } from "./strudel-validate-core.js";

interface ValidateRequest {
  id: number;
  code: string;
  cycles?: number;
  timeoutMs?: number;
}

function isRequest(msg: unknown): msg is ValidateRequest {
  const m = msg as ValidateRequest | undefined;
  return typeof m?.id === "number" && typeof m?.code === "string";
}

const send = (msg: unknown): void => {
  // `process.send` is absent if this file is ever run without an IPC channel;
  // exiting is better than silently evaluating untrusted code into the void.
  if (!process.send) process.exit(2);
  process.send(msg);
};

process.on("message", (msg: unknown) => {
  if (!isRequest(msg)) return;
  const { id, code, cycles, timeoutMs } = msg;
  // validateStrudelInProcess never throws; the catch is for the impossible.
  void validateStrudelInProcess(code, { cycles, timeoutMs }).then(
    (result) => send({ id, result }),
    (err: unknown) => send({ id, result: { ok: false, error: { message: String(err) } } }),
  );
});

// A parent that goes away leaves nothing to answer.
process.on("disconnect", () => process.exit(0));

// Warm up before announcing readiness: the first validation otherwise pays for
// importing ~200 KiB of Strudel and running evalScope, which would land inside
// the caller's timeout budget rather than the host's (generous) spawn budget.
void validateStrudelInProcess('s("bd")', { cycles: 1, timeoutMs: 10_000 }).then(
  () => send({ type: "ready" }),
  () => send({ type: "ready" }),
);
