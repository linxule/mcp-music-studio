// Pure user-agent → client classifier for analytics. Extracted from the worker
// so it can be unit-tested without the worker's html/agents imports.

export function parseClient(ua: string): string {
  const lower = ua.toLowerCase();
  if (lower === "claude-user") return "claude-ai";
  if (lower.includes("claude-ai") || lower.includes("claude.ai"))
    return "claude-ai";
  if (lower.includes("claude-code") || lower.includes("claude code"))
    return "claude-code";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("cline")) return "cline";
  if (lower.includes("smithery")) return "smithery";
  if (lower.includes("mcp-remote")) return "mcp-remote";
  return "unknown";
}
