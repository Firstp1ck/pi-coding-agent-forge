import { isDeepStrictEqual } from "node:util";

const DEFAULT_RESULT_BYTES = 512_000;

export type HostTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  reachesTools?: ((input: Record<string, unknown>) => "all" | readonly string[]) | undefined;
};

export type ExecuteTool = (
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export type ResearchToolKind = "brave_search" | "web_search" | "fetch_content";

export type ResearchToolSet = {
  searches: HostTool[];
  fetch: HostTool;
  byName: ReadonlyMap<string, ResearchToolKind>;
};

export type T3ToolSet = {
  capabilities: HostTool;
  delegateTask: HostTool;
  taskStatus: HostTool;
  taskCancel: HostTool;
};

export class ToolBridgeError extends Error {
  readonly kind: "access" | "invalid_result" | "limit" | "policy";
  constructor(message: string, kind: "access" | "invalid_result" | "limit" | "policy" = "invalid_result") {
    super(message);
    this.name = "ToolBridgeError";
    this.kind = kind;
  }
}

export function normalizeToolName(name: string): string {
  return name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function logicalSuffix(name: string, logicalName: string): boolean {
  const segment = name.split(/__|\./).at(-1) ?? name;
  return normalizeToolName(segment) === normalizeToolName(logicalName);
}

function uniqueMatch(tools: readonly HostTool[], logicalName: string, namespace?: string): HostTool | undefined {
  const matches = tools.filter((tool) => {
    if (!tool || typeof tool.name !== "string") return false;
    const normalized = normalizeToolName(tool.name);
    return logicalSuffix(tool.name, logicalName) && (!namespace || tool.name.split(/__|\./).slice(0, -1).some(segment => normalizeToolName(segment) === normalizeToolName(namespace)));
  });
  if (matches.length > 1) {
    throw new ToolBridgeError(`Ambiguous ${logicalName} tools: ${matches.map((tool) => tool.name).join(", ")}`);
  }
  return matches[0];
}

/** Resolve only the three approved web tool families. At least one search tool and fetch_content are required. */
export function discoverResearchTools(tools: readonly HostTool[]): ResearchToolSet {
  const brave = uniqueMatch(tools, "brave_search");
  const web = uniqueMatch(tools, "web_search");
  const fetch = uniqueMatch(tools, "model_research_fetch") ?? uniqueMatch(tools, "fetch_content");
  const searches = [brave, web].filter((tool): tool is HostTool => Boolean(tool));
  if (searches.length === 0) throw new ToolBridgeError("Research requires callable brave_search or web_search");
  if (!fetch) throw new ToolBridgeError("Research requires callable fetch_content");
  const byName = new Map<string, ResearchToolKind>();
  if (brave) byName.set(brave.name, "brave_search");
  if (web) byName.set(web.name, "web_search");
  byName.set(fetch.name, "fetch_content");
  return { searches, fetch, byName };
}

/** Resolve app-owned T3 orchestration operations without accepting similarly named non-T3 tools. */
export function discoverT3Tools(tools: readonly HostTool[]): T3ToolSet {
  const capabilities = uniqueMatch(tools, "orchestrator_capabilities", "t3code");
  const delegateTask = uniqueMatch(tools, "delegate_task", "t3code");
  const taskStatus = uniqueMatch(tools, "task_status", "t3code");
  const taskCancel = uniqueMatch(tools, "task_cancel", "t3code");
  const missing = [
    ["orchestrator_capabilities", capabilities],
    ["delegate_task", delegateTask],
    ["task_status", taskStatus],
    ["task_cancel", taskCancel],
  ].filter(([, tool]) => !tool).map(([name]) => name);
  if (missing.length > 0) throw new ToolBridgeError(`Missing callable T3 tools: ${missing.join(", ")}`);
  return { capabilities: capabilities!, delegateTask: delegateTask!, taskStatus: taskStatus!, taskCancel: taskCancel! };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") throw new ToolBridgeError("Tool result text must be a string");
  if (byteLength(value) > maxBytes) throw new ToolBridgeError(`Tool result exceeds ${maxBytes} bytes`, "limit");
  return value;
}

function resultShape(raw: unknown): { isError: boolean; content: unknown; structuredContent: unknown } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolBridgeError("Host executeTool returned an invalid result");
  const outer = raw as Record<string, unknown>;
  const nested = outer.result && typeof outer.result === "object" && !Array.isArray(outer.result)
    ? outer.result as Record<string, unknown>
    : outer;
  return {
    isError: outer.isError === true || nested.isError === true,
    content: nested.content,
    structuredContent: nested.structuredContent,
  };
}

function contentText(content: unknown, maxBytes: number): string {
  if (!Array.isArray(content)) throw new ToolBridgeError("Tool result has no text content");
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  if (parts.length === 0) throw new ToolBridgeError("Tool result has no text content");
  return boundedText(parts.join("\n"), maxBytes);
}

export type InjectedToolBridge = {
  call(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  callJson(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  callText(name: string, args: unknown, signal?: AbortSignal): Promise<string>;
};

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    work.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

function parseTransportJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* T3 may flatten identical text and structured JSON. */ }
  const documents: unknown[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor++;
    if (cursor === text.length) break;
    if (text[cursor] !== "{" || documents.length >= 4) throw new ToolBridgeError("Expected JSON or identical transport JSON documents");
    const start = cursor;
    let depth = 0; let quoted = false; let escaped = false; let closed = false;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") {
        depth--;
        if (depth === 0) { cursor++; closed = true; break; }
      }
    }
    if (!closed) throw new ToolBridgeError("Unterminated transport JSON document");
    let value: unknown;
    try { value = JSON.parse(text.slice(start, cursor)); } catch { throw new ToolBridgeError("Invalid transport JSON document"); }
    if (documents.length && !isDeepStrictEqual(documents[0], value)) throw new ToolBridgeError("Conflicting transport JSON documents");
    documents.push(value);
  }
  if (!documents.length) throw new ToolBridgeError("Expected a JSON result");
  return documents[0];
}

function recoverTaskHandle(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const outer = raw as Record<string, unknown>;
  const result = outer.result && typeof outer.result === "object" ? outer.result as Record<string, unknown> : outer;
  let value = result.structuredContent;
  if (value === undefined && Array.isArray(result.content)) {
    const parts: string[] = [];
    let length = 0;
    for (const item of result.content) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      length += item.text.length;
      if (length > 1_000_000) return undefined;
      parts.push(item.text);
    }
    try { value = parseTransportJson(parts.join("\n")); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || !("taskId" in value)) return undefined;
  const taskId = value.taskId;
  return typeof taskId === "string" && taskId.trim() && taskId.length <= 2_000 ? taskId : undefined;
}

/** Wrap host execution so validation, permission, and result hooks remain on the host path. */
export function createInjectedToolBridge(
  executeTool: ExecuteTool,
  options: { maxResultBytes?: number } = {},
): InjectedToolBridge {
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_RESULT_BYTES;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1_024) throw new ToolBridgeError("maxResultBytes must be a positive bounded integer");

  async function call(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    let raw: unknown;
    try { raw = await abortable(Promise.resolve().then(() => executeTool(name, args, { signal })), signal); }
    catch (error) {
      signal?.throwIfAborted();
      throw new ToolBridgeError(`${name}: ${error instanceof Error ? error.message : String(error)}`, "access");
    }
    try {
      const result = resultShape(raw);
      if (result.isError) {
        let message = "Host tool reported an error";
        try { message = contentText(result.content, Math.min(maxResultBytes, 32_000)); } catch { /* retain generic error */ }
        const declared = result.structuredContent && typeof result.structuredContent === "object" && "errorKind" in result.structuredContent ? result.structuredContent.errorKind : undefined;
        const kind = declared === "access" || declared === "policy" || declared === "limit" || declared === "invalid_result" ? declared : logicalSuffix(name, "model_research_fetch") ? "invalid_result" : "access";
        throw new ToolBridgeError(`${name}: ${message}`, kind);
      }
      if (result.structuredContent !== undefined) {
        const serialized = JSON.stringify(result.structuredContent);
        if (serialized === undefined || byteLength(serialized) > maxResultBytes) throw new ToolBridgeError(`${name}: structured result is too large or unserializable`, "limit");
        return result.structuredContent;
      }
      return contentText(result.content, maxResultBytes);
    } catch (error) {
      const taskId = recoverTaskHandle(raw);
      if (taskId && error instanceof Error) Object.assign(error, { taskId });
      throw error;
    }
  }

  async function callJson(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await call(name, args, signal);
    let parsed: unknown = value;
    if (typeof value === "string") {
      try { parsed = parseTransportJson(value); } catch (error) {
        throw new ToolBridgeError(`${name}: expected JSON result: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
      throw new ToolBridgeError(`${name}: expected a JSON object result`);
    }
    return parsed as Record<string, unknown>;
  }

  async function callText(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const value = await call(name, args, signal);
    if (typeof value === "string") return value;
    return boundedText(JSON.stringify(value), maxResultBytes);
  }

  return { call, callJson, callText };
}
