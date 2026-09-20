import {
	StringEnum,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type TranscriptContext,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	TOOL_RESULT_RECOVERY_TOOL_NAME,
	createToolResultRecoveryCustomTools,
	providerToolResultSerializationOptionsFromEnv,
	serializeProviderContextWithMetadata,
	type ProviderContextSerializationMetadata,
	type ToolResultRecoveryRecord,
} from "./context.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const ENV_KEY = "CURSOR_API_KEY";
const MODEL_ID = "composer-2.5";
const PI_PROVIDER_ID = "cursor-composer";
const PI_MODEL_REF = `${PI_PROVIDER_ID}/${MODEL_ID}`;
const CUSTOM_MESSAGE_TYPE = "cursor-composer-result";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const INSTALL_HINT = `cd ${EXTENSION_DIR} && npm install`;
const STATUS_KEY = "cursor-composer";
const CURSOR_COMPOSER_CONTEXT_WINDOW = 200_000;
const CURSOR_COMPOSER_MAX_TOKENS = 16_384;
const CURSOR_COMPOSER_FAST_COST_PER_MILLION = { input: 3, output: 15 } as const;
const CURSOR_COMPOSER_STANDARD_COST_PER_MILLION = { input: 0.5, output: 2.5 } as const;

type RunMode = "agent" | "plan";
type Thinking = "low" | "medium" | "high";

type ApiKeySource = "environment" | "workspace .env" | "Pi global .env";

type ApiKeyResolution = {
	apiKey?: string;
	source?: ApiKeySource;
	path?: string;
};

type CursorComposerUsageSource = "token-delta" | "turn-ended";

type CursorComposerUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	source: CursorComposerUsageSource;
};

type CursorComposerCostRates = Model<Api>["cost"];

type RunCursorComposerOptions = {
	prompt: string;
	cwd: string;
	apiKey: string;
	mode: RunMode;
	thinking?: Thinking;
	autoReview: boolean;
	sandbox: boolean;
	signal?: AbortSignal;
	onStatus?: (message: string) => void;
	onTextDelta?: (delta: string, accumulated: string) => void;
	onUsage?: (usage: CursorComposerUsage) => void;
	toolResultRecoveryRecords?: ToolResultRecoveryRecord[];
};

type CursorComposerResult = {
	agentId?: string;
	requestId?: string;
	status?: string;
	result: string;
	model?: unknown;
	durationMs?: number;
	git?: unknown;
	usage?: CursorComposerUsage;
};

const CursorComposerParams = Type.Object({
	prompt: Type.String({ description: "The task to delegate to Cursor Composer 2.5." }),
	mode: Type.Optional(
		StringEnum(["agent", "plan"] as const, {
			description: "Cursor run mode. agent may modify files; plan should explore/design first.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["low", "medium", "high"] as const, {
			description: "Optional Composer thinking effort parameter. Omit to use Cursor's default.",
		}),
	),
	workspaceSubdir: Type.Optional(
		Type.String({
			description:
				"Optional workspace subdirectory under the current Pi cwd to run Cursor from. Absolute paths and parent traversal are rejected.",
		}),
	),
	autoReview: Type.Optional(
		Type.Boolean({
			description:
				"Use Cursor local auto-review for tool calls. Defaults to true. If unavailable, Cursor may fall back to normal local behavior.",
		}),
	),
	sandbox: Type.Optional(
		Type.Boolean({
			description:
				"Enable Cursor SDK local sandbox. Defaults to false because unsupported hosts throw configuration errors.",
		}),
	),
});

function globalEnvPath(): string {
	return join(homedir(), ".pi", "agent", ".env");
}

function workspaceEnvPath(cwd: string): string {
	return join(cwd, ".env");
}

function parseEnvLineValue(raw: string): string {
	let value = raw.trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return value.replace(/\\n/g, "\n");
}

function readEnvValue(filePath: string, key: string): string | undefined {
	if (!existsSync(filePath)) return undefined;
	const content = readFileSync(filePath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match || match[1] !== key) continue;
		return parseEnvLineValue(match[2] ?? "");
	}
	return undefined;
}

function quoteEnvValue(value: string): string {
	return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function upsertEnvValue(filePath: string, key: string, value: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const nextLine = `${key}=${quoteEnvValue(value)}`;
	const lines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
	let replaced = false;
	const next = lines.map((line) => {
		if (line.trim().startsWith("#")) return line;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match?.[1] !== key) return line;
		replaced = true;
		return nextLine;
	});
	if (!replaced) next.push(nextLine);
	writeFileSync(filePath, `${next.filter((line, index) => line.length > 0 || index < next.length - 1).join("\n")}\n`, "utf8");
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown): number {
	const parsed = typeof value === "bigint" ? Number(value) : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.floor(parsed);
}

function cursorComposerPriceTier(): "fast" | "standard" {
	const raw = process.env.CURSOR_COMPOSER_PRICE_TIER?.trim().toLowerCase();
	return raw === "standard" || raw === "slow" || raw === "economy" ? "standard" : "fast";
}

function cursorComposerCostRates(): CursorComposerCostRates {
	const base = cursorComposerPriceTier() === "standard"
		? CURSOR_COMPOSER_STANDARD_COST_PER_MILLION
		: CURSOR_COMPOSER_FAST_COST_PER_MILLION;
	const input = envNumber("CURSOR_COMPOSER_INPUT_COST_PER_MILLION", base.input);
	const output = envNumber("CURSOR_COMPOSER_OUTPUT_COST_PER_MILLION", base.output);
	return {
		input,
		output,
		// Cursor publishes input/output prices, not a separate cache discount. Bill
		// cache tokens at the active input rate unless explicitly overridden.
		cacheRead: envNumber("CURSOR_COMPOSER_CACHE_READ_COST_PER_MILLION", input),
		cacheWrite: envNumber("CURSOR_COMPOSER_CACHE_WRITE_COST_PER_MILLION", input),
	};
}

function describeCursorComposerPricing(rates = cursorComposerCostRates()): string {
	return `${cursorComposerPriceTier()} ($${rates.input}/M input, $${rates.output}/M output, $${rates.cacheRead}/M cache-read, $${rates.cacheWrite}/M cache-write)`;
}

function resolveApiKey(cwd: string): ApiKeyResolution {
	if (process.env[ENV_KEY]) return { apiKey: process.env[ENV_KEY], source: "environment" };

	const workspacePath = workspaceEnvPath(cwd);
	const workspaceKey = readEnvValue(workspacePath, ENV_KEY);
	if (workspaceKey) return { apiKey: workspaceKey, source: "workspace .env", path: workspacePath };

	const piPath = globalEnvPath();
	const piKey = readEnvValue(piPath, ENV_KEY);
	if (piKey) return { apiKey: piKey, source: "Pi global .env", path: piPath };

	return {};
}

function primeApiKeyFromEnvFiles(cwd: string): void {
	if (process.env[ENV_KEY]) return;
	const resolution = resolveApiKey(cwd);
	if (resolution.apiKey) process.env[ENV_KEY] = resolution.apiKey;
}

function settingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

function readSettingsFile(): Record<string, unknown> {
	const filePath = settingsPath();
	if (!existsSync(filePath)) return {};
	const raw = readFileSync(filePath, "utf8").trim();
	if (!raw) return {};
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(settings: Record<string, unknown>): void {
	const filePath = settingsPath();
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function getEnabledModelRefs(): string[] | undefined {
	const settings = readSettingsFile();
	const enabledModels = settings.enabledModels;
	return Array.isArray(enabledModels) ? enabledModels.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function addCursorComposerToScopedModels(): { changed: boolean; path: string; enabledModels?: string[]; hadExplicitScope: boolean } {
	const filePath = settingsPath();
	const settings = readSettingsFile();
	const current = settings.enabledModels;
	const hadExplicitScope = Array.isArray(current) && current.length > 0;
	const enabledModels = Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
	if (enabledModels.includes(PI_MODEL_REF)) {
		return { changed: false, path: filePath, enabledModels, hadExplicitScope };
	}
	enabledModels.push(PI_MODEL_REF);
	settings.enabledModels = enabledModels;
	writeSettingsFile(settings);
	return { changed: true, path: filePath, enabledModels, hadExplicitScope };
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveWorkspace(cwd: string, workspaceSubdir?: string): string {
	if (!workspaceSubdir?.trim()) return cwd;
	if (isAbsolute(workspaceSubdir)) {
		throw new Error("workspaceSubdir must be relative to the current Pi cwd, not absolute.");
	}
	const root = resolve(cwd);
	const target = resolve(root, workspaceSubdir);
	if (!isInside(root, target)) {
		throw new Error("workspaceSubdir must stay inside the current Pi cwd.");
	}
	if (!existsSync(target)) throw new Error(`workspaceSubdir does not exist: ${workspaceSubdir}`);
	return target;
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

function truncateForTool(text: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let output = truncation.content;
	if (truncation.truncated) {
		output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	}
	return { text: output, truncated: truncation.truncated };
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function calculateUsageCost(usage: Usage, rates: CursorComposerCostRates): Usage {
	usage.cost.input = (rates.input / 1_000_000) * usage.input;
	usage.cost.output = (rates.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage;
}

function buildUsage(input: number, output: number, cacheRead: number, cacheWrite: number, rates: CursorComposerCostRates): Usage {
	const usage = emptyUsage();
	usage.input = input;
	usage.output = output;
	usage.cacheRead = cacheRead;
	usage.cacheWrite = cacheWrite;
	usage.totalTokens = input + output + cacheRead + cacheWrite;
	return calculateUsageCost(usage, rates);
}

function cursorUsageToPiUsage(usage: CursorComposerUsage, rates: CursorComposerCostRates): Usage {
	return buildUsage(
		nonNegativeInteger(usage.inputTokens),
		nonNegativeInteger(usage.outputTokens),
		nonNegativeInteger(usage.cacheReadTokens),
		nonNegativeInteger(usage.cacheWriteTokens),
		rates,
	);
}

function estimateTokensFromText(text: string): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

function estimatePiUsage(prompt: string, output: string, rates: CursorComposerCostRates, knownOutputTokens = 0): Usage {
	return buildUsage(
		estimateTokensFromText(prompt),
		knownOutputTokens > 0 ? knownOutputTokens : estimateTokensFromText(output),
		0,
		0,
		rates,
	);
}

function usageHasTokens(usage: Usage): boolean {
	return Boolean(usage.input || usage.output || usage.cacheRead || usage.cacheWrite);
}

function formatResultMessage(result: CursorComposerResult): string {
	const lines = ["Cursor Composer 2.5 result", ""];
	if (result.status) lines.push(`Status: ${result.status}`);
	if (result.requestId) lines.push(`Request ID: ${result.requestId}`);
	if (result.agentId) lines.push(`Agent ID: ${result.agentId}`);
	if (typeof result.durationMs === "number") lines.push(`Duration: ${Math.round(result.durationMs / 1000)}s`);
	lines.push("", result.result || "(no final text returned)");
	return lines.join("\n");
}

function parseCommandArgs(raw: string | undefined): {
	prompt: string;
	mode: RunMode;
	thinking?: Thinking;
	workspaceSubdir?: string;
	autoReview: boolean;
	sandbox: boolean;
} {
	const defaults = {
		prompt: "",
		mode: "agent" as RunMode,
		thinking: undefined as Thinking | undefined,
		workspaceSubdir: undefined as string | undefined,
		autoReview: true,
		sandbox: false,
	};
	if (!raw?.trim()) return defaults;

	const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	const promptParts: string[] = [];
	for (const originalToken of tokens) {
		const token = originalToken.replace(/^(["'])(.*)\1$/, "$2");
		if (token === "--plan") defaults.mode = "plan";
		else if (token === "--agent") defaults.mode = "agent";
		else if (token === "--sandbox") defaults.sandbox = true;
		else if (token === "--no-auto-review") defaults.autoReview = false;
		else if (token.startsWith("--thinking=")) {
			const value = token.slice("--thinking=".length);
			if (["low", "medium", "high"].includes(value)) defaults.thinking = value as Thinking;
			else promptParts.push(originalToken);
		} else if (token.startsWith("--cwd=")) {
			defaults.workspaceSubdir = token.slice("--cwd=".length);
		} else if (token.startsWith("--workspace-subdir=")) {
			defaults.workspaceSubdir = token.slice("--workspace-subdir=".length);
		} else {
			promptParts.push(token);
		}
	}
	defaults.prompt = promptParts.join(" ").trim();
	return defaults;
}

async function loadCursorSdk(): Promise<any> {
	try {
		return await import("@cursor/sdk");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`@cursor/sdk is not installed for the cursor-composer extension. Run: ${INSTALL_HINT}. Original error: ${message}`);
	}
}

async function disposeAgent(agent: any): Promise<void> {
	const asyncDispose = agent?.[Symbol.asyncDispose];
	if (typeof asyncDispose === "function") {
		await asyncDispose.call(agent);
		return;
	}
	if (typeof agent?.close === "function") agent.close();
}

function cursorEventAssistantText(event: any): string {
	const content = event?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block?.type === "text") return block.text ?? "";
			if (typeof block?.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function emitCursorTextDelta(nextText: string, state: { emitted: string }, options: RunCursorComposerOptions): void {
	if (!nextText) return;
	let delta = nextText;
	if (nextText.startsWith(state.emitted)) {
		delta = nextText.slice(state.emitted.length);
	} else if (state.emitted.includes(nextText)) {
		delta = "";
	} else if (state.emitted) {
		delta = `\n${nextText}`;
	}
	if (!delta) return;
	state.emitted += delta;
	options.onTextDelta?.(delta, state.emitted);
}

function compactJson(value: unknown, maxLength = 1200): string {
	try {
		const text = JSON.stringify(value, (_key, nested) => {
			if (typeof nested === "string" && nested.length > 500) return `${nested.slice(0, 500)}…`;
			return nested;
		}, 2);
		return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
	} catch {
		return String(value);
	}
}

function cursorEventDetails(event: any): string {
	const details: Record<string, unknown> = {};
	for (const key of ["message", "error", "details", "code", "statusText", "requestId", "request_id", "run_id"]) {
		if (event?.[key] !== undefined) details[key] = event[key];
	}
	return Object.keys(details).length > 0 ? `: ${compactJson(details)}` : "";
}

function providerVerbosity(): "quiet" | "normal" | "debug" {
	const raw = process.env.CURSOR_COMPOSER_PROVIDER_VERBOSITY?.trim().toLowerCase();
	if (raw === "debug" || raw === "verbose") return "debug";
	if (raw === "normal" || raw === "status") return "normal";
	return "quiet";
}

function shouldForwardProviderStatus(message: string): boolean {
	const verbosity = providerVerbosity();
	if (verbosity === "debug") return true;
	if (/^\[thinking\]/i.test(message)) return false;
	if (/\[status\]\s+ERROR/i.test(message)) return true;
	if (/\[request\]/i.test(message)) return true;
	if (/\[stream warning\]/i.test(message)) return true;
	if (/failed|error|cancelled/i.test(message) && !/tool-call-completed/i.test(message)) return true;
	if (verbosity === "normal") {
		if (/^Cursor Composer 2\.5 is still working/i.test(message)) return true;
		if (/\[tool\]/i.test(message)) return true;
		return /\[status\]/i.test(message) && !/\b(RUNNING|FINISHED)\b/i.test(message);
	}
	return false;
}

function cursorConversationErrorSummary(conversation: unknown): unknown {
	if (conversation === undefined) return undefined;
	if (Array.isArray(conversation)) return { type: "array", items: conversation.length };
	if (conversation && typeof conversation === "object") {
		return { type: "object", keys: Object.keys(conversation as Record<string, unknown>).slice(0, 12) };
	}
	return { type: typeof conversation };
}

function cursorRunErrorMessage(result: any, run: any, conversation?: unknown): string {
	const requestId = result?.requestId ?? run?.requestId;
	const parts = ["Cursor Composer run failed"];
	if (requestId) parts.push(`requestId=${requestId}`);
	if (result?.result) parts.push(truncateForTool(String(result.result)).text);
	parts.push(compactJson({ status: result?.status, model: result?.model, git: result?.git, conversation: cursorConversationErrorSummary(conversation) }));
	return parts.filter(Boolean).join(" — ");
}

function cursorEventStatusText(event: any): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	if (event.type === "status") {
		const status = event.status ?? "update";
		return /^ERROR$/i.test(String(status)) ? `[status] ${status}${cursorEventDetails(event)}` : `[status] ${status}`;
	}
	if (event.type === "tool_call") return `[tool] ${event.name ?? "tool"}: ${event.status ?? "running"}`;
	if (event.type === "task") return `[task] ${event.status ?? "update"}${event.text ? `: ${event.text}` : ""}`;
	if (event.type === "request") return `[request] Cursor is awaiting ${event.request_id ?? "input/approval"}${cursorEventDetails(event)}`;
	if (event.type === "thinking" && event.text) return `[thinking] ${event.text}`;
	return undefined;
}

async function consumeCursorRunStream(run: any, options: RunCursorComposerOptions, textState: { emitted: string }): Promise<void> {
	if (typeof run?.stream !== "function") return;
	for await (const event of run.stream()) {
		if (options.signal?.aborted) break;
		if (event?.type === "assistant") {
			emitCursorTextDelta(cursorEventAssistantText(event), textState, options);
			continue;
		}
		const status = cursorEventStatusText(event);
		if (status) options.onStatus?.(status);
	}
}

async function runCursorComposer(options: RunCursorComposerOptions): Promise<CursorComposerResult> {
	const sdk = await loadCursorSdk();
	const Agent = sdk.Agent;
	if (!Agent?.create) throw new Error("@cursor/sdk did not expose Agent.create(). Is the installed SDK version current?");

	const model: { id: string; params?: Array<{ id: string; value: string }> } = { id: MODEL_ID };
	if (options.thinking) model.params = [{ id: "thinking", value: options.thinking }];

	let agent: any;
	let run: any;
	let removeAbortListener: (() => void) | undefined;
	const textState = { emitted: "" };
	let latestUsage: CursorComposerUsage | undefined;
	const usageState = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	const emitUsage = (source: CursorComposerUsageSource) => {
		latestUsage = { ...usageState, source };
		options.onUsage?.(latestUsage);
	};

	try {
		const recoveryTools = createToolResultRecoveryCustomTools(options.toolResultRecoveryRecords ?? [], {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLineCount: DEFAULT_MAX_LINES,
		});
		options.onStatus?.(`Creating Cursor local agent in ${options.cwd}`);
		if (recoveryTools) {
			options.onStatus?.(`Registered ${TOOL_RESULT_RECOVERY_TOOL_NAME} for exact truncated Pi tool-result recovery`);
		}
		agent = await Agent.create({
			apiKey: options.apiKey,
			model,
			mode: options.mode,
			local: {
				cwd: options.cwd,
				autoReview: options.autoReview,
				sandboxOptions: { enabled: options.sandbox },
				...(recoveryTools ? { customTools: recoveryTools } : {}),
			},
		});

		options.onStatus?.(`Running Composer 2.5 (${agent.agentId ?? "local agent"})`);
		run = await agent.send(options.prompt, {
			mode: options.mode,
			onDelta: ({ update }: { update: any }) => {
				if (update?.type === "text-delta" && typeof update.text === "string") {
					emitCursorTextDelta(textState.emitted + update.text, textState, options);
					return;
				}
				if (update?.type === "token-delta") {
					usageState.outputTokens += nonNegativeInteger(update.tokens);
					emitUsage("token-delta");
					return;
				}
				if (update?.type === "turn-ended" && update.usage) {
					usageState.inputTokens = nonNegativeInteger(update.usage.inputTokens);
					usageState.outputTokens = nonNegativeInteger(update.usage.outputTokens);
					usageState.cacheReadTokens = nonNegativeInteger(update.usage.cacheReadTokens);
					usageState.cacheWriteTokens = nonNegativeInteger(update.usage.cacheWriteTokens);
					emitUsage("turn-ended");
				}
			},
		});

		if (options.signal) {
			const abort = () => {
				try {
					run?.cancel?.();
				} catch {
					// Best-effort cancellation only.
				}
			};
			if (options.signal.aborted) abort();
			else {
				options.signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
			}
		}

		try {
			await consumeCursorRunStream(run, options, textState);
		} catch (error) {
			options.onStatus?.(`[stream warning] ${error instanceof Error ? error.message : String(error)}`);
		}

		const result = await run.wait();
		if (result?.status === "error") {
			let conversation: unknown;
			try {
				conversation = typeof run?.conversation === "function" ? await run.conversation() : undefined;
			} catch (error) {
				conversation = { error: error instanceof Error ? error.message : String(error) };
			}
			throw new Error(cursorRunErrorMessage(result, run, conversation));
		}
		const finalText = normalizeText(result?.result || "");
		if (finalText && !textState.emitted.includes(finalText)) emitCursorTextDelta(finalText, textState, options);
		return {
			agentId: agent.agentId,
			requestId: result?.requestId ?? run?.requestId,
			status: result?.status,
			result: normalizeText(result?.result || textState.emitted),
			model: result?.model ?? agent.model,
			durationMs: result?.durationMs,
			git: result?.git,
			usage: latestUsage,
		};
	} finally {
		removeAbortListener?.();
		if (agent) await disposeAgent(agent);
	}
}

function thinkingFromProviderOptions(options?: SimpleStreamOptions): Thinking | undefined {
	const value = options?.reasoning;
	if (value === "medium" || value === "high") return value;
	if (value === "minimal" || value === "low") return "low";
	if (value === "xhigh") return "high";
	return undefined;
}

function summarizeProviderContextTruncation(metadata: ProviderContextSerializationMetadata): string | undefined {
	const truncated = metadata.truncatedToolResults;
	if (truncated.length === 0) return undefined;
	const originalBytes = truncated.reduce((total, item) => total + item.originalBytes, 0);
	const previewBytes = truncated.reduce((total, item) => total + item.previewBytes, 0);
	const omittedBytes = truncated.reduce((total, item) => total + item.omittedBytes, 0);
	const toolNames = Array.from(new Set(truncated.map((item) => item.toolName))).slice(0, 4).join(", ");
	const toolSuffix = toolNames ? ` (${toolNames}${truncated.length > 4 ? ", …" : ""})` : "";
	const recoverableCount = truncated.filter((item) => item.recoveryId).length;
	const recoverySuffix = recoverableCount > 0 ? ` ${recoverableCount} recoverable through ${TOOL_RESULT_RECOVERY_TOOL_NAME}.` : "";
	return `Pi Cursor provider truncated ${truncated.length} prior tool result${truncated.length === 1 ? "" : "s"}${toolSuffix}: sent ${formatSize(previewBytes)} of ${formatSize(originalBytes)}, omitted ${formatSize(omittedBytes)}.${recoverySuffix}`;
}

function providerAutoReview(): boolean {
	return process.env.CURSOR_COMPOSER_PROVIDER_AUTO_REVIEW !== "false";
}

function providerSandbox(): boolean {
	return process.env.CURSOR_COMPOSER_PROVIDER_SANDBOX === "true";
}

function providerHeartbeatMs(): number {
	const raw = process.env.CURSOR_COMPOSER_PROVIDER_HEARTBEAT_MS?.trim();
	if (raw === "0" || raw === "false") return 0;
	const parsed = raw ? Number(raw) : 15_000;
	if (!Number.isFinite(parsed) || parsed <= 0) return 15_000;
	return Math.max(5_000, Math.floor(parsed));
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function streamCursorComposerProvider(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const thinking = thinkingFromProviderOptions(options);
		const serializedContext = serializeProviderContextWithMetadata(context, {
			maxToolResultBytes: DEFAULT_MAX_BYTES,
			maxToolResultLines: DEFAULT_MAX_LINES,
		});
		const promptText = serializedContext.prompt;
		const toolResultRecoveryRecords = serializedContext.metadata.toolResultRecoveryRecords;
		const truncationSummary = summarizeProviderContextTruncation(serializedContext.metadata);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let textIndex = -1;
		let thinkingIndex = -1;
		let streamedText = "";
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		let finished = false;
		let sawAuthoritativeUsage = false;
		const startedAt = Date.now();
		const applyCursorUsage = (usage: CursorComposerUsage) => {
			output.usage = cursorUsageToPiUsage(usage, model.cost);
			if (usage.source === "turn-ended") sawAuthoritativeUsage = true;
		};
		const ensureTextBlock = () => {
			if (textIndex !== -1) return textIndex;
			output.content.push({ type: "text", text: "" });
			textIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			return textIndex;
		};
		const pushText = (delta: string) => {
			if (!delta || finished) return;
			const index = ensureTextBlock();
			const block = output.content[index];
			if (block?.type === "text") block.text += delta;
			streamedText += delta;
			stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
		};
		const ensureThinkingBlock = () => {
			if (thinkingIndex !== -1) return thinkingIndex;
			output.content.push({ type: "thinking", thinking: "" } as any);
			thinkingIndex = output.content.length - 1;
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
			return thinkingIndex;
		};
		const pushThinking = (delta: string) => {
			if (!delta || finished) return;
			const index = ensureThinkingBlock();
			const block = output.content[index] as any;
			if (block?.type === "thinking") block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
		};
		const pushProviderStatus = (message: string) => {
			if (!shouldForwardProviderStatus(message)) return;
			pushThinking(`${message.trimEnd()}\n`);
		};
		const startHeartbeat = () => {
			const intervalMs = providerHeartbeatMs();
			if (intervalMs <= 0) return;
			pushThinking(`Cursor Composer 2.5 is working…\n`);
			heartbeatTimer = setInterval(() => {
				pushProviderStatus(`Cursor Composer 2.5 is still working (${formatElapsed(Date.now() - startedAt)} elapsed).`);
			}, intervalMs);
		};
		const stopHeartbeat = () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			if (thinkingIndex !== -1) {
				const block = output.content[thinkingIndex] as any;
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: block?.type === "thinking" ? block.thinking : "",
					partial: output,
				});
			}
		};

		try {
			stream.push({ type: "start", partial: output });
			startHeartbeat();
			if (truncationSummary) {
				pushProviderStatus(truncationSummary);
				output.diagnostics = [
					...(output.diagnostics ?? []),
					{
						type: "cursor-composer.provider_context_truncated",
						timestamp: Date.now(),
						details: {
							summary: truncationSummary,
							truncatedToolResults: serializedContext.metadata.truncatedToolResults,
						},
					},
				];
			}
			const apiKey = options?.apiKey ?? resolveApiKey(process.cwd()).apiKey;
			if (!apiKey) throw new Error(`${ENV_KEY} is missing. Run /cursor-composer-setup first.`);

			const result = await runCursorComposer({
				prompt: promptText,
				cwd: process.cwd(),
				apiKey,
				mode: "agent",
				thinking,
				autoReview: providerAutoReview(),
				sandbox: providerSandbox(),
				signal: options?.signal,
				onStatus: pushProviderStatus,
				onTextDelta: (delta) => pushText(delta),
				onUsage: applyCursorUsage,
				toolResultRecoveryRecords,
			});

			if (result.status === "cancelled") throw new Error("Cursor Composer run cancelled.");
			if (result.requestId) output.responseId = result.requestId;
			const responseModel = (result.model as any)?.id;
			if (typeof responseModel === "string") output.responseModel = responseModel;
			if (result.usage) applyCursorUsage(result.usage);

			stopHeartbeat();
			const finalText = result.result || streamedText;
			if (!sawAuthoritativeUsage || !usageHasTokens(output.usage)) {
				const knownOutputTokens = output.usage.output;
				output.usage = estimatePiUsage(promptText, finalText, model.cost, knownOutputTokens);
				output.diagnostics = [
					...(output.diagnostics ?? []),
					{
						type: "cursor-composer.usage_estimated",
						timestamp: Date.now(),
						details: {
							reason: sawAuthoritativeUsage ? "Cursor SDK emitted empty usage" : "Cursor SDK did not emit final turn-ended usage",
							cache: "not estimated",
						},
					},
				];
			}
			if (!streamedText && finalText) pushText(finalText);
			finished = true;
			if (textIndex !== -1) {
				const block = output.content[textIndex];
				stream.push({
					type: "text_end",
					contentIndex: textIndex,
					content: block?.type === "text" ? block.text : finalText,
					partial: output,
				});
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			finished = true;
			stopHeartbeat();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function shouldRequireConfirmation(): boolean {
	return process.env.CURSOR_COMPOSER_REQUIRE_CONFIRMATION !== "false";
}

async function promptForApiKey(ctx: { cwd: string; ui: any }): Promise<void> {
	const existing = resolveApiKey(ctx.cwd);
	if (existing.apiKey) {
		ctx.ui.notify(`${ENV_KEY} is already configured via ${existing.source}${existing.path ? ` (${existing.path})` : ""}.`, "info");
		return;
	}

	const apiKey = await ctx.ui.input("Cursor API key", "Paste CURSOR_API_KEY / crsr_... value");
	const trimmed = apiKey?.trim();
	if (!trimmed) {
		ctx.ui.notify("Cursor Composer setup cancelled: no API key entered.", "warning");
		return;
	}

	const target = await ctx.ui.select("Save Cursor API key where?", ["Pi global .env", "Current workspace .env", "Only this process"]);
	if (!target) {
		ctx.ui.notify("Cursor Composer setup cancelled: no save location selected.", "warning");
		return;
	}

	if (target === "Only this process") {
		process.env[ENV_KEY] = trimmed;
		ctx.ui.notify(`${ENV_KEY} set for this Pi process only.`, "info");
		return;
	}

	const filePath = target === "Pi global .env" ? globalEnvPath() : workspaceEnvPath(ctx.cwd);
	upsertEnvValue(filePath, ENV_KEY, trimmed);
	process.env[ENV_KEY] = trimmed;
	ctx.ui.notify(`${ENV_KEY} saved to ${filePath}`, "info");
}

async function promptForScopedModelSetup(ctx: { ui: any }): Promise<void> {
	const current = getEnabledModelRefs();
	if (current?.includes(PI_MODEL_REF)) {
		ctx.ui.notify(`${PI_MODEL_REF} is already in Pi enabledModels (${settingsPath()}).`, "info");
		return;
	}

	const hasExplicitScope = Array.isArray(current) && current.length > 0;
	const message = hasExplicitScope
		? `Pi already has a scoped-model list with ${current.length} entries. Add ${PI_MODEL_REF} so it appears in /scoped-models, /model scoped tab, and Ctrl+P cycling after a new/reloaded session?`
		: `Pi has no explicit scoped-model list, which normally means all available models are shown. Add ${PI_MODEL_REF} anyway? This creates enabledModels with Cursor Composer as the first explicit scoped model.`;
	const ok = await ctx.ui.confirm("Add Composer 2.5 to Pi scoped models?", message);
	if (!ok) return;

	const result = addCursorComposerToScopedModels();
	const note = result.hadExplicitScope
		? "Start a new Pi session or use /scoped-models to refresh the current session scope."
		: "This created an explicit enabledModels list. Add other models with /scoped-models if you want them in Ctrl+P cycling.";
	ctx.ui.notify(
		`${result.changed ? "Added" : "Already present"}: ${PI_MODEL_REF} in ${result.path}. ${note}`,
		result.hadExplicitScope ? "info" : "warning",
	);
}

export default function cursorComposerExtension(pi: ExtensionAPI): void {
	primeApiKeyFromEnvFiles(process.cwd());
	pi.registerProvider(PI_PROVIDER_ID, {
		name: "Cursor Composer",
		baseUrl: "cursor-sdk://local",
		apiKey: `$${ENV_KEY}`,
		api: "cursor-sdk-agent" as any,
		models: [
			{
				id: MODEL_ID,
				name: "Cursor Composer 2.5 (SDK local agent)",
				reasoning: true,
				thinkingLevelMap: {
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "high",
				},
				input: ["text"],
				cost: cursorComposerCostRates(),
				contextWindow: CURSOR_COMPOSER_CONTEXT_WINDOW,
				maxTokens: CURSOR_COMPOSER_MAX_TOKENS,
			},
		],
		streamSimple: streamCursorComposerProvider,
	});

	pi.on("session_start", (_event, ctx) => {
		primeApiKeyFromEnvFiles(ctx.cwd);
	});

	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
		return new Text(theme.fg("accent", theme.bold("Cursor Composer 2.5")) + "\n" + message.content, 0, 0);
	});

	pi.registerCommand("cursor-composer-setup", {
		description: "Configure CURSOR_API_KEY and optionally add Composer 2.5 to Pi scoped models",
		handler: async (_args, ctx) => {
			await promptForApiKey(ctx);
			await promptForScopedModelSetup(ctx);
		},
	});

	pi.registerCommand("cursor-composer-add-scoped-model", {
		description: "Add cursor-composer/composer-2.5 to Pi enabledModels for /scoped-models and Ctrl+P cycling",
		handler: async (_args, ctx) => {
			await promptForScopedModelSetup(ctx);
		},
	});

	pi.registerCommand("cursor-composer-status", {
		description: "Show Cursor Composer 2.5 extension status",
		handler: async (_args, ctx) => {
			const key = resolveApiKey(ctx.cwd);
			const enabledModels = getEnabledModelRefs();
			const scopedStatus = enabledModels?.includes(PI_MODEL_REF)
				? `present in enabledModels (${settingsPath()})`
				: enabledModels
					? `not in enabledModels (${settingsPath()})`
					: `no explicit enabledModels list; all models are implicitly available`;
			let sdkStatus = "not checked";
			try {
				await loadCursorSdk();
				sdkStatus = "installed";
			} catch (error) {
				sdkStatus = error instanceof Error ? error.message : String(error);
			}
			const truncation = providerToolResultSerializationOptionsFromEnv(process.env, {
				maxToolResultBytes: DEFAULT_MAX_BYTES,
				maxToolResultLines: DEFAULT_MAX_LINES,
			});
			const truncationStatus = truncation.truncateToolResults
				? `on (${formatSize(truncation.maxToolResultBytes)}, ${truncation.maxToolResultLines.toLocaleString()} lines)`
				: "off";
			ctx.ui.notify(
				`${ENV_KEY}: ${key.apiKey ? `configured via ${key.source}${key.path ? ` (${key.path})` : ""}` : "missing"}\n@cursor/sdk: ${sdkStatus}\nPi provider: ${PI_MODEL_REF}\nPricing: ${describeCursorComposerPricing()}\nContext: ${CURSOR_COMPOSER_CONTEXT_WINDOW.toLocaleString()} tokens\nTool-result truncation: ${truncationStatus}\nScoped models: ${scopedStatus}`,
				key.apiKey && sdkStatus === "installed" ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("cursor-composer-models", {
		description: "List Cursor SDK models visible to the configured API key",
		handler: async (_args, ctx) => {
			const { apiKey } = resolveApiKey(ctx.cwd);
			if (!apiKey) {
				ctx.ui.notify(`${ENV_KEY} is missing. Run /cursor-composer-setup first.`, "error");
				return;
			}
			const sdk = await loadCursorSdk();
			if (!sdk.Cursor?.models?.list) throw new Error("Installed @cursor/sdk does not expose Cursor.models.list().");
			const models = await sdk.Cursor.models.list({ apiKey });
			const composer = Array.isArray(models) ? models.find((model: any) => model?.id === MODEL_ID) : undefined;
			const content = composer
				? `Composer 2.5 is available:\n${JSON.stringify(composer, null, 2)}`
				: `Composer 2.5 was not found. Visible models:\n${JSON.stringify(models, null, 2)}`;
			pi.sendMessage({ customType: CUSTOM_MESSAGE_TYPE, content, display: true });
		},
	});

	pi.registerCommand("cursor-composer", {
		description:
			"Delegate an explicit prompt to Cursor SDK Composer 2.5. Flags: --plan, --agent, --thinking=high, --sandbox, --no-auto-review, --cwd=subdir",
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			let prompt = parsed.prompt;
			if (!prompt) {
				if (!ctx.hasUI) throw new Error("No prompt provided. Usage: /cursor-composer [flags] <prompt>");
				prompt = (await ctx.ui.editor("Prompt for Cursor Composer 2.5", ""))?.trim() ?? "";
			}
			if (!prompt) {
				ctx.ui.notify("Cursor Composer run cancelled: no prompt provided.", "warning");
				return;
			}

			const { apiKey } = resolveApiKey(ctx.cwd);
			if (!apiKey) {
				ctx.ui.notify(`${ENV_KEY} is missing. Run /cursor-composer-setup first.`, "error");
				return;
			}

			const workspace = resolveWorkspace(ctx.cwd, parsed.workspaceSubdir);
			ctx.ui.setStatus(STATUS_KEY, "Composer 2.5 running");
			ctx.ui.setWidget(STATUS_KEY, [`Cursor Composer 2.5 running`, `cwd: ${workspace}`, `mode: ${parsed.mode}`]);
			try {
				const result = await runCursorComposer({
					prompt,
					cwd: workspace,
					apiKey,
					mode: parsed.mode,
					thinking: parsed.thinking,
					autoReview: parsed.autoReview,
					sandbox: parsed.sandbox,
					onStatus: (message) => ctx.ui.setStatus(STATUS_KEY, message),
					onTextDelta: (_delta, accumulated) => {
						const preview = accumulated.length > 800 ? `…${accumulated.slice(-800)}` : accumulated;
						ctx.ui.setWidget(STATUS_KEY, [`Cursor Composer 2.5 streaming`, `cwd: ${workspace}`, "", preview]);
					},
				});
				pi.sendMessage({ customType: CUSTOM_MESSAGE_TYPE, content: formatResultMessage(result), display: true, details: result });
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerTool({
		name: "cursor_composer_agent",
		label: "Cursor Composer Agent",
		description:
			"Delegate an explicit coding task to Cursor SDK Composer 2.5 in the current workspace. This can run commands and edit files through Cursor's local agent runtime. Output is truncated to protect Pi context.",
		promptSnippet: "Delegate explicit coding tasks to Cursor SDK Composer 2.5 when the user asks to use Cursor/Composer.",
		promptGuidelines: [
			"Use cursor_composer_agent only when the user explicitly asks to use Cursor, Composer, or a delegated Cursor agent.",
			"Before cursor_composer_agent runs, explain that Cursor SDK local mode may run commands and edit files in the workspace.",
		],
		parameters: CursorComposerParams,
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("cursor_composer_agent "));
			text += theme.fg("accent", args.mode === "plan" ? "plan" : "agent");
			if (typeof args.workspaceSubdir === "string" && args.workspaceSubdir.trim()) {
				text += theme.fg("dim", ` cwd=${args.workspaceSubdir}`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { apiKey } = resolveApiKey(ctx.cwd);
			if (!apiKey) throw new Error(`${ENV_KEY} is missing. Run /cursor-composer-setup first.`);

			const workspace = resolveWorkspace(ctx.cwd, params.workspaceSubdir);
			const mode = (params.mode ?? "agent") as RunMode;
			const autoReview = params.autoReview ?? true;
			const sandbox = params.sandbox ?? false;

			if (shouldRequireConfirmation()) {
				if (!ctx.hasUI) {
					throw new Error(
						"cursor_composer_agent requires interactive confirmation by default. Set CURSOR_COMPOSER_REQUIRE_CONFIRMATION=false only if you accept unattended Cursor SDK tool execution.",
					);
				}
				const ok = await ctx.ui.confirm(
					"Run Cursor Composer 2.5?",
					`Composer will run in ${workspace} with mode=${mode}. It may inspect files, execute commands, and edit the workspace.\n\nPrompt:\n${params.prompt.slice(0, 800)}`,
				);
				if (!ok) throw new Error("Cursor Composer 2.5 run cancelled by user.");
			}

			onUpdate?.({ content: [{ type: "text", text: `Starting Cursor Composer 2.5 in ${workspace} (${mode})...` }] });
			const result = await runCursorComposer({
				prompt: params.prompt,
				cwd: workspace,
				apiKey,
				mode,
				thinking: params.thinking as Thinking | undefined,
				autoReview,
				sandbox,
				signal,
				onStatus: (message) => onUpdate?.({ content: [{ type: "text", text: message }] }),
			});

			const formatted = formatResultMessage(result);
			const truncated = truncateForTool(formatted);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: {
					provider: "cursor-sdk",
					model: MODEL_ID,
					workspace,
					mode,
					thinking: params.thinking,
					autoReview,
					sandbox,
					truncated: truncated.truncated,
					requestId: result.requestId,
					agentId: result.agentId,
					status: result.status,
					durationMs: result.durationMs,
					git: result.git,
				},
			};
		},
	});
}
