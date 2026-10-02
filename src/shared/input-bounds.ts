// Input bounds shared by the tool schemas (src/shared/tool-defs.ts re-exports
// them). Dependency-free, so a widget can import a schema without the rest.

/** Max length of a score or pattern, in characters. */
export const MAX_SOURCE_CHARS = 64 * 1024;
