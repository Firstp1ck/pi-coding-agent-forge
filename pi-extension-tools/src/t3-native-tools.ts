/** Recognize T3's injected namespace and Pi's normalized MCP namespace. */
export function isT3NativeTool(name: string): boolean {
  return /^(?:mcp__t3-code__|mcp__t3_code__)\S+$/.test(name);
}
