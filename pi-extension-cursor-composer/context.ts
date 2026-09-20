import type { SDKCustomTool } from "@cursor/sdk";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import { parseBooleanFlag } from "@firstpick/pi-utils/env";
import { sha256Text as sha256 } from "@firstpick/pi-utils/hash";
import { formatBytes } from "@firstpick/pi-utils/text";

// Keep provider replay truncation aligned with Pi's normal tool-output truncation defaults.
// These mirror @earendil-works/pi-coding-agent DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES
// without adding a test-time dependency on Pi internals for this source-repo package.
export const DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES = 51_200;
export const DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES = 2_000;

export type ProviderToolResultSerializationOptions = {
	truncateToolResults: boolean;
	maxToolResultBytes: number;
	maxToolResultLines: number;
};

export const TOOL_RESULT_RECOVERY_TOOL_NAME = "pi_get_truncated_tool_result";

export type TruncatedToolResultMetadata = {
	toolName: string;
	toolCallId?: string;
	recoveryId?: string;
	originalBytes: number;
	originalLines: number;
	previewBytes: number;
	previewLines: number;
	omittedBytes: number;
	sha256: string;
};

export type ToolResultRecoveryRecord = {
	id: string;
	toolName: string;
	toolCallId?: string;
	text: string;
	originalBytes: number;
	originalLines: number;
	sha256: string;
};

export type ProviderContextSerializationMetadata = {
	truncatedToolResults: TruncatedToolResultMetadata[];
	toolResultRecoveryRecords: ToolResultRecoveryRecord[];
};

export type ProviderContextSerializationResult = {
	prompt: string;
	metadata: ProviderContextSerializationMetadata;
};

export type ProviderContextSerializationOptions = Partial<ProviderToolResultSerializationOptions> & {
	includeSystemPrompt?: boolean;
	systemPrompt?: string;
	messages?: unknown[];
	taskLines?: string[];
	conversationTitle?: string;
	enableToolResultRecovery?: boolean;
	recoveryIdFactory?: () => string;
};

type TextPreview = {
	text: string;
	headText: string;
	tailText: string;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
	previewBytes: number;
	previewLines: number;
	sha256: string;
};

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split(/\r?\n/).length;
}

export function deterministicToolResultRecoveryId(toolName: string, toolCallId: string | undefined, contentSha256: string): string {
	const stableIdentity = JSON.stringify({ toolName, toolCallId: toolCallId ?? null, contentSha256 });
	return `ptr_${sha256(stableIdentity).slice(0, 24)}`;
}

function normalizeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function clipTextToBytes(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	let clipped = "";
	for (const char of text) {
		if (byteLength(clipped + char) > maxBytes) break;
		clipped += char;
	}
	return clipped;
}

function takeHead(lines: string[], maxLines: number, maxBytes: number): string {
	const selected = lines.slice(0, Math.max(0, maxLines));
	const parts: string[] = [];
	let usedBytes = 0;
	for (const line of selected) {
		const prefix = parts.length === 0 ? "" : "\n";
		const candidate = `${prefix}${line}`;
		const candidateBytes = byteLength(candidate);
		if (usedBytes + candidateBytes > maxBytes) {
			const remaining = Math.max(0, maxBytes - usedBytes - byteLength(prefix));
			const clipped = clipTextToBytes(line, remaining);
			if (clipped) parts.push(`${prefix}${clipped}`);
			break;
		}
		parts.push(candidate);
		usedBytes += candidateBytes;
	}
	return parts.join("");
}

function takeTail(lines: string[], maxLines: number, maxBytes: number): string {
	const selected = lines.slice(Math.max(0, lines.length - Math.max(0, maxLines)));
	const parts: string[] = [];
	let usedBytes = 0;
	for (let index = selected.length - 1; index >= 0; index -= 1) {
		const line = selected[index];
		const suffix = parts.length === 0 ? "" : "\n";
		const candidate = `${line}${suffix}`;
		const candidateBytes = byteLength(candidate);
		if (usedBytes + candidateBytes > maxBytes) {
			const remaining = Math.max(0, maxBytes - usedBytes - byteLength(suffix));
			const clipped = clipTextToBytes(line, remaining);
			if (clipped) parts.unshift(`${clipped}${suffix}`);
			break;
		}
		parts.unshift(candidate);
		usedBytes += candidateBytes;
	}
	return parts.join("");
}

export function providerToolResultSerializationOptionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	defaults: Pick<ProviderToolResultSerializationOptions, "maxToolResultBytes" | "maxToolResultLines"> = {
		maxToolResultBytes: DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES,
		maxToolResultLines: DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES,
	},
): ProviderToolResultSerializationOptions {
	return {
		truncateToolResults: parseBooleanFlag(env.CURSOR_COMPOSER_PROVIDER_TRUNCATE_TOOL_RESULTS, true),
		maxToolResultBytes: defaults.maxToolResultBytes,
		maxToolResultLines: defaults.maxToolResultLines,
	};
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return normalizeText(content);
	return content
		.map((block: any) => {
			if (block?.type === "text") return block.text ?? "";
			if (block?.type === "thinking") return `[thinking]\n${block.thinking ?? ""}`;
			if (block?.type === "toolCall") return `[tool call: ${block.name ?? "unknown"}]\n${normalizeText(block.arguments)}`;
			if (block?.type === "image") return "[image omitted by Pi Cursor provider wrapper]";
			return normalizeText(block);
		})
		.filter(Boolean)
		.join("\n");
}

export function previewTextByBytesAndLines(
	text: string,
	maxBytes: number,
	maxLines: number,
): TextPreview {
	const originalBytes = byteLength(text);
	const originalLines = lineCount(text);
	const digest = sha256(text);
	if (originalBytes <= maxBytes && originalLines <= maxLines) {
		return {
			text,
			headText: text,
			tailText: "",
			truncated: false,
			originalBytes,
			originalLines,
			previewBytes: originalBytes,
			previewLines: originalLines,
			sha256: digest,
		};
	}

	const lines = text.split(/\r?\n/);
	const headLineBudget = Math.max(1, Math.ceil(maxLines / 2));
	const tailLineBudget = Math.max(0, maxLines - headLineBudget);
	const headByteBudget = Math.max(1, Math.ceil(maxBytes / 2));
	const tailByteBudget = Math.max(0, maxBytes - headByteBudget);
	const headText = takeHead(lines, headLineBudget, headByteBudget);
	const tailText = tailLineBudget > 0 && tailByteBudget > 0 ? takeTail(lines, tailLineBudget, tailByteBudget) : "";
	const textParts = [headText];
	if (tailText) textParts.push("[... middle omitted ...]", tailText);
	const previewText = textParts.filter(Boolean).join("\n");

	return {
		text: previewText,
		headText,
		tailText,
		truncated: true,
		originalBytes,
		originalLines,
		previewBytes: byteLength(headText) + byteLength(tailText),
		previewLines: lineCount(headText) + lineCount(tailText),
		sha256: digest,
	};
}

export function serializeToolResultContent(
	content: unknown,
	options: ProviderToolResultSerializationOptions,
	metadata?: {
		toolName?: string;
		toolCallId?: string;
		truncatedToolResults?: TruncatedToolResultMetadata[];
		toolResultRecoveryRecords?: ToolResultRecoveryRecord[];
		enableToolResultRecovery?: boolean;
		recoveryIdFactory?: () => string;
	},
): string {
	const text = contentToText(content);
	if (!options.truncateToolResults) return text;
	const preview = previewTextByBytesAndLines(text, options.maxToolResultBytes, options.maxToolResultLines);
	if (!preview.truncated) return text;
	const toolName = metadata?.toolName ?? "tool";
	const recoveryEnabled = (metadata?.enableToolResultRecovery ?? true) && Boolean(metadata?.toolResultRecoveryRecords);
	const recoveryId = recoveryEnabled
		? (metadata?.recoveryIdFactory ?? (() => deterministicToolResultRecoveryId(toolName, metadata?.toolCallId, preview.sha256)))()
		: undefined;
	metadata?.truncatedToolResults?.push({
		toolName,
		toolCallId: metadata?.toolCallId,
		recoveryId,
		originalBytes: preview.originalBytes,
		originalLines: preview.originalLines,
		previewBytes: preview.previewBytes,
		previewLines: preview.previewLines,
		omittedBytes: Math.max(0, preview.originalBytes - preview.previewBytes),
		sha256: preview.sha256,
	});
	if (recoveryId) {
		metadata?.toolResultRecoveryRecords?.push({
			id: recoveryId,
			toolName,
			toolCallId: metadata?.toolCallId,
			text,
			originalBytes: preview.originalBytes,
			originalLines: preview.originalLines,
			sha256: preview.sha256,
		});
	}
	return [
		"[Large tool result truncated by Pi Cursor provider wrapper]",
		`Tool: ${toolName}.`,
		...(metadata?.toolCallId ? [`Tool call ID: ${metadata.toolCallId}.`] : []),
		...(recoveryId ? [`Recovery ID: ${recoveryId}.`] : []),
		`Original: ${preview.originalLines} lines, ${formatBytes(preview.originalBytes, { binary: true, precision: 1, trimTrailingZeros: false })}.`,
		`Included preview: ${preview.previewLines} lines, ${formatBytes(preview.previewBytes, { binary: true, precision: 1, trimTrailingZeros: false })}.`,
		`Original SHA-256: ${preview.sha256}.`,
		"Reason: avoid resending very large prior Pi tool outputs to Cursor Composer on every provider turn.",
		...(recoveryId
			? [
				`If exact historical content is required, call the Cursor local tool ${TOOL_RESULT_RECOVERY_TOOL_NAME} with this Recovery ID and an optional line range.`,
			]
			: [
				"If exact historical content is required, disable CURSOR_COMPOSER_PROVIDER_TRUNCATE_TOOL_RESULTS or use available tools to re-read/rerun when safe and equivalent.",
			]),
		"",
		"<tool_result_preview_head>",
		preview.headText,
		"</tool_result_preview_head>",
		...(preview.tailText
			? ["", "<tool_result_preview_tail>", preview.tailText, "</tool_result_preview_tail>"]
			: []),
	].join("\n");
}

function integerArg(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.floor(parsed);
}

function lineSegmentsPreservingEndings(text: string): string[] {
	if (!text) return [];
	const segments: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char !== "\r" && char !== "\n") continue;
		if (char === "\r" && text[index + 1] === "\n") index += 1;
		segments.push(text.slice(start, index + 1));
		start = index + 1;
	}
	if (start < text.length) {
		segments.push(text.slice(start));
	} else if (text.length > 0) {
		segments.push("");
	}
	return segments;
}

export function readToolResultRecoveryRecord(
	records: ToolResultRecoveryRecord[],
	args: Record<string, unknown>,
	options: { defaultLineCount?: number; maxLineCount?: number; maxBytes?: number } = {},
): {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent: Record<string, string | number | boolean | null>;
} {
	const id = typeof args.id === "string" ? args.id : typeof args.recoveryId === "string" ? args.recoveryId : "";
	const record = records.find((candidate) => candidate.id === id);
	if (!record) {
		return {
			content: [{ type: "text", text: `No truncated Pi tool result found for recovery ID: ${id || "<missing>"}` }],
			isError: true,
			structuredContent: { id: id || null, found: false },
		};
	}

	const defaultLineCount = Math.max(1, options.defaultLineCount ?? 200);
	const maxLineCount = Math.max(1, options.maxLineCount ?? DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES);
	const lines = lineSegmentsPreservingEndings(record.text);
	const requestedStartLine = Math.max(1, integerArg(args.startLine, 1));
	const requestedLineCount = Math.max(1, integerArg(args.lineCount, defaultLineCount));
	const returnedLineCount = Math.min(requestedLineCount, maxLineCount);
	if (requestedStartLine > record.originalLines) {
		return {
			content: [
				{
					type: "text",
					text: `Recovery ID ${record.id} has ${record.originalLines} lines; requested startLine ${requestedStartLine} is past the end of the output.`,
				},
			],
			isError: true,
			structuredContent: {
				id: record.id,
				found: true,
				toolName: record.toolName,
				toolCallId: record.toolCallId ?? null,
				sha256: record.sha256,
				originalBytes: record.originalBytes,
				originalLines: record.originalLines,
				startLine: requestedStartLine,
				endLine: record.originalLines,
				returnedBytes: 0,
				truncatedByBytes: false,
				hasMore: false,
			},
		};
	}
	const startIndex = requestedStartLine - 1;
	const endIndex = Math.min(lines.length, startIndex + returnedLineCount);
	let text = lines.slice(startIndex, endIndex).join("");
	let truncatedByBytes = false;
	if (byteLength(text) > maxBytes) {
		text = clipTextToBytes(text, maxBytes);
		truncatedByBytes = true;
	}
	const actualStartLine = startIndex + 1;
	const actualEndLine = endIndex;
	const header = [
		`Recovered exact Pi tool result slice for ${record.toolName}.`,
		`Recovery ID: ${record.id}.`,
		...(record.toolCallId ? [`Tool call ID: ${record.toolCallId}.`] : []),
		`Original: ${record.originalLines} lines, ${formatBytes(record.originalBytes, { binary: true, precision: 1, trimTrailingZeros: false })}, SHA-256 ${record.sha256}.`,
		`Returned lines ${actualStartLine}-${actualEndLine}${truncatedByBytes ? `, clipped to ${formatBytes(maxBytes, { binary: true, precision: 1, trimTrailingZeros: false })}` : ""}.`,
		endIndex < record.originalLines || truncatedByBytes ? "Request a later startLine or smaller lineCount for more exact content." : "End of recovered output.",
	].join("\n");

	return {
		content: [{ type: "text", text: `${header}\n\n<recovered_tool_result>\n${text}\n</recovered_tool_result>` }],
		structuredContent: {
			id: record.id,
			found: true,
			toolName: record.toolName,
			toolCallId: record.toolCallId ?? null,
			sha256: record.sha256,
			originalBytes: record.originalBytes,
			originalLines: record.originalLines,
			startLine: actualStartLine,
			endLine: actualEndLine,
			returnedBytes: byteLength(text),
			truncatedByBytes,
			hasMore: endIndex < record.originalLines || truncatedByBytes,
		},
	};
}

export function createToolResultRecoveryCustomTools(
	records: ToolResultRecoveryRecord[],
	options: { defaultLineCount?: number; maxLineCount?: number; maxBytes?: number } = {},
): Record<string, SDKCustomTool> | undefined {
	if (records.length === 0) return undefined;
	return {
		[TOOL_RESULT_RECOVERY_TOOL_NAME]: {
			description:
				"Fetch an exact slice of a large historical Pi tool result that was truncated in the Cursor Composer provider prompt. Use the Recovery ID shown in the truncation marker.",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "string", description: "Recovery ID from the truncated Pi tool-result marker." },
					startLine: { type: "number", description: "1-based first line to return. Defaults to 1." },
					lineCount: { type: "number", description: "Number of lines to return. Defaults to 200 and is capped." },
				},
				required: ["id"],
			},
			execute: (args: Record<string, unknown>) => readToolResultRecoveryRecord(records, args, options),
		},
	};
}

export function serializeProviderContextWithMetadata(
	context: unknown,
	options: ProviderContextSerializationOptions = {},
): ProviderContextSerializationResult {
	const contextObject = (context ?? {}) as any;
	const toolOptions: ProviderToolResultSerializationOptions = {
		...providerToolResultSerializationOptionsFromEnv(),
		...options,
	};
	const metadata: ProviderContextSerializationMetadata = { truncatedToolResults: [], toolResultRecoveryRecords: [] };
	const includeSystemPrompt = options.includeSystemPrompt ?? true;
	const messages = options.messages ?? contextObject.messages ?? [];
	const transcript = normalizeContext({ systemPrompt: contextObject.systemPrompt, messages });
	const systemPrompt = options.systemPrompt ?? getCurrentSystemPrompt(transcript.messages);
	const taskLines = options.taskLines ?? [
		"You are being called from Pi through the Cursor SDK Composer 2.5 provider wrapper.",
		"Respond to the latest user request. If you modify files, summarize the exact changes and verification.",
	];
	const lines: string[] = [];
	if (includeSystemPrompt && systemPrompt) {
		lines.push("# Pi system prompt", String(systemPrompt), "");
	}
	lines.push("# Task", ...taskLines, "", options.conversationTitle ?? "# Conversation");
	for (const message of messages as any[]) {
		// System deltas have already been replayed into the current prompt above.
		if (message?.role === "system") continue;
		if (message?.role === "toolResult") {
			const toolName = message.toolName ?? "tool";
			lines.push(
				`## toolResult ${toolName}`,
				serializeToolResultContent(message.content, toolOptions, {
					toolName,
					toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
					truncatedToolResults: metadata.truncatedToolResults,
					toolResultRecoveryRecords: metadata.toolResultRecoveryRecords,
					enableToolResultRecovery: options.enableToolResultRecovery,
					recoveryIdFactory: options.recoveryIdFactory,
				}),
				"",
			);
		} else {
			lines.push(`## ${message?.role ?? "message"}`, contentToText(message?.content), "");
		}
	}
	return { prompt: lines.join("\n").trim(), metadata };
}

export function serializeProviderContext(context: unknown, options: ProviderContextSerializationOptions = {}): string {
	return serializeProviderContextWithMetadata(context, options).prompt;
}
