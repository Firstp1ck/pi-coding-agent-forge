export type TextToolResult<T = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  details: T | undefined;
  isError?: boolean;
};

export function textToolResult<T = unknown>(text: string, details?: T, options: { isError?: boolean } = {}): TextToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(options.isError === undefined ? {} : { isError: options.isError }),
  };
}

export function jsonToolResult<T = unknown>(payload: T, options: { space?: number; isError?: boolean } = {}): TextToolResult<T> {
  return textToolResult(JSON.stringify(payload, null, options.space ?? 2), payload, { isError: options.isError });
}
