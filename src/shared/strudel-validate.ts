/**
 * Server-side validation of Strudel code — the entry point.
 *
 * What validation reports, and why the server does it at all, is documented in
 * ./strudel-validate-core.ts. This file is only about WHERE the pattern runs.
 *
 * Validating means executing code an LLM wrote. Until v0.5 that only ever
 * happened in the widget's CSP-pinned browser iframe; doing it server-side put
 * `Function(modelCode)()` in the MCP server's own process, next to its
 * environment and on the thread that answers JSON-RPC. So the run goes into a
 * forked, env-stripped, SIGKILL-able child (./strudel-validate-host.ts) which
 * evaluates inside a node:vm context (evalStrudelSandboxed in
 * ./strudel-eval.ts). The host's file header has the threat model and — more
 * usefully — the honest list of what this still does not contain.
 *
 * The child is spawned on first use and kept warm, so only the first validation
 * of a server's life pays the ~150-400 ms start-up.
 */
export type {
  StrudelValidation,
  StrudelValidationError,
  ValidateOptions,
} from "./strudel-validation-types.js";

import type { StrudelValidation, ValidateOptions } from "./strudel-validation-types.js";

/**
 * Evaluate `code` out of process and report what it does.
 *
 * Never throws, never blocks the event loop, and always answers within roughly
 * `timeoutMs`: a broken, hostile or non-terminating pattern is a result, not an
 * exception.
 *
 * The host module is loaded lazily so that importing this file costs nothing —
 * it keeps `node:child_process` out of bundles that only want the types (the
 * Cloudflare Worker imports `StrudelValidation` from here through tool-defs.ts,
 * and workerd has neither child processes nor `new Function`).
 */
export async function validateStrudelCode(
  code: string,
  options: ValidateOptions = {},
): Promise<StrudelValidation> {
  const { validateStrudelIsolated } = await import("./strudel-validate-host.js");
  return validateStrudelIsolated(code, options);
}

/**
 * Kill the warm validation child, if one is running.
 *
 * The host also registers a `process.on("exit")` hook, so this is only needed
 * where a process wants to stop the child without exiting (tests, a server
 * shutting a transport down).
 */
export async function shutdownStrudelValidation(): Promise<void> {
  const { shutdownStrudelValidator } = await import("./strudel-validate-host.js");
  shutdownStrudelValidator();
}
