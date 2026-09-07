// =============================================================================
// safeJsonForScript — JSON literal safe to inline inside a <script> element
//
// JSON.stringify doesn't escape <, > or &. Inlined into a <script> block, a
// payload containing `</script><script>alert(1)` would break out of the block.
// Unicode-escaping those three characters keeps the literal inert while parsing
// to exactly the same value.
//
// Dependency-free so both the Node browser-fallback generators and any future
// worker-side HTML emitter can share it.
// =============================================================================

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
