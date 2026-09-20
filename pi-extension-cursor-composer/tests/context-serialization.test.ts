import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES,
	DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES,
	TOOL_RESULT_RECOVERY_TOOL_NAME,
	createToolResultRecoveryCustomTools,
	deterministicToolResultRecoveryId,
	previewTextByBytesAndLines,
	providerToolResultSerializationOptionsFromEnv,
	serializeProviderContext,
	serializeProviderContextWithMetadata,
	serializeToolResultContent,
} from "../context.ts";

function contextWithToolResult(toolText: string, toolName = "read", toolCallId = "call-read-1") {
	return {
		systemPrompt: "system instructions stay visible",
		messages: [
			{ role: "user", content: [{ type: "text", text: "please inspect the file" }] },
			{ role: "toolResult", toolName, toolCallId, content: [{ type: "text", text: toolText }] },
			{ role: "assistant", content: [{ type: "text", text: "I inspected it." }] },
			{ role: "user", content: [{ type: "text", text: "now summarize" }] },
		],
	};
}

test("normalized transcripts replay system sections and deltas without duplicating stale instructions", () => {
	const context = normalizeContext({ messages: [
		{ role: "system", content: "BASE_INSTRUCTIONS", sections: { rules: "OLD_RULES", temporary: "REMOVED_RULES" }, timestamp: 0 },
		{ role: "user", content: "Inspect the file", timestamp: 1 },
		{ role: "system", content: [{ type: "text", text: "ADDITIONAL_INSTRUCTIONS" }], sections: { rules: "CURRENT_RULES", temporary: null }, timestamp: 2 },
		{ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "file evidence" }], isError: false, timestamp: 3 },
	] });
	const before = structuredClone(context);
	const prompt = serializeProviderContext(context);
	assert.match(prompt, /# Pi system prompt\nBASE_INSTRUCTIONS/);
	assert.match(prompt, /ADDITIONAL_INSTRUCTIONS/);
	assert.match(prompt, /CURRENT_RULES/);
	assert.doesNotMatch(prompt, /OLD_RULES|REMOVED_RULES|## system/);
	assert.equal(prompt.match(/BASE_INSTRUCTIONS/g)?.length, 1);
	assert.match(prompt, /## user\nInspect the file/);
	assert.match(prompt, /## toolResult read\nfile evidence/);
	assert.deepEqual(context, before, "serialization must not mutate the transcript");
});

test("system prompt overrides and exclusions also apply to normalized transcripts", () => {
	const context = normalizeContext({ systemPrompt: "ORIGINAL_INSTRUCTIONS", messages: [
		{ role: "system", content: "LATER_INSTRUCTIONS", sections: { rules: "SECTION_INSTRUCTIONS" }, timestamp: 1 },
		{ role: "user", content: "user request", timestamp: 2 },
	] });
	const overridden = serializeProviderContext(context, { systemPrompt: "OVERRIDE_INSTRUCTIONS" });
	assert.match(overridden, /# Pi system prompt\nOVERRIDE_INSTRUCTIONS/);
	assert.doesNotMatch(overridden, /ORIGINAL_INSTRUCTIONS|LATER_INSTRUCTIONS|SECTION_INSTRUCTIONS|## system/);
	for (const options of [{ includeSystemPrompt: false }, { systemPrompt: "" }]) {
		const prompt = serializeProviderContext(context, options);
		assert.doesNotMatch(prompt, /INSTRUCTIONS|# Pi system prompt|## system/);
		assert.match(prompt, /user request/);
	}
});

test("message overrides supply the system deltas to replay", () => {
	const context = normalizeContext({ systemPrompt: "UNSELECTED_INSTRUCTIONS", messages: [] });
	const prompt = serializeProviderContext(context, { messages: [
		{ role: "system", content: "SELECTED_INSTRUCTIONS", sections: { rules: "SELECTED_RULES" }, timestamp: 0 },
		{ role: "user", content: "selected request", timestamp: 1 },
	] });
	assert.match(prompt, /SELECTED_INSTRUCTIONS/);
	assert.match(prompt, /SELECTED_RULES/);
	assert.doesNotMatch(prompt, /UNSELECTED_INSTRUCTIONS|## system/);
});

test("small tool results remain intact", () => {
	const small = "alpha\nbeta\ngamma";
	const prompt = serializeProviderContext(contextWithToolResult(small), {
		truncateToolResults: true,
		maxToolResultBytes: 1_000,
		maxToolResultLines: 100,
	});
	assert.match(prompt, /# Pi system prompt/);
	assert.match(prompt, /## user/);
	assert.match(prompt, /## toolResult read/);
	assert.match(prompt, /alpha\nbeta\ngamma/);
	assert.doesNotMatch(prompt, /Large tool result truncated/);
});

test("large tool results are previewed with metadata while preserving conversation skeleton", () => {
	const huge = Array.from({ length: 2_000 }, (_, i) => `line-${i.toString().padStart(4, "0")} ${"x".repeat(80)}`).join("\n");
	const unoptimized = serializeProviderContext(contextWithToolResult(huge), {
		truncateToolResults: false,
	});
	const { prompt: optimized, metadata } = serializeProviderContextWithMetadata(contextWithToolResult(huge), {
		truncateToolResults: true,
		maxToolResultBytes: 4_000,
		maxToolResultLines: 50,
		recoveryIdFactory: () => "test-recovery-read-1",
	});

	assert.ok(optimized.length < unoptimized.length * 0.25, `expected optimized prompt to be <25% of baseline (${optimized.length}/${unoptimized.length})`);
	assert.match(optimized, /# Pi system prompt/);
	assert.match(optimized, /## user/);
	assert.match(optimized, /## toolResult read/);
	assert.match(optimized, /## assistant/);
	assert.match(optimized, /Original: 2000 lines/);
	assert.match(optimized, /Recovery ID: test-recovery-read-1/);
	assert.match(optimized, /Original SHA-256: [a-f0-9]{64}/);
	assert.match(optimized, new RegExp(`call the Cursor local tool ${TOOL_RESULT_RECOVERY_TOOL_NAME}`));
	assert.match(optimized, /<tool_result_preview_head>/);
	assert.match(optimized, /<tool_result_preview_tail>/);
	assert.match(optimized, /line-0000/);
	assert.match(optimized, /line-1999/);
	assert.equal(metadata.truncatedToolResults.length, 1);
	assert.equal(metadata.truncatedToolResults[0].toolName, "read");
	assert.equal(metadata.truncatedToolResults[0].recoveryId, "test-recovery-read-1");
	assert.equal(metadata.truncatedToolResults[0].originalLines, 2_000);
	assert.ok(metadata.truncatedToolResults[0].omittedBytes > 0);
	assert.equal(metadata.toolResultRecoveryRecords.length, 1);
	assert.equal(metadata.toolResultRecoveryRecords[0].id, "test-recovery-read-1");
	assert.equal(metadata.toolResultRecoveryRecords[0].text, huge);
});

test("tool-result truncation can be disabled", () => {
	const huge = "a".repeat(20_000);
	const rendered = serializeToolResultContent([{ type: "text", text: huge }], {
		truncateToolResults: false,
		maxToolResultBytes: 10,
		maxToolResultLines: 1,
	});
	assert.equal(rendered, huge);
});

test("recovery custom tool returns exact omitted tool-result slices", async () => {
	const huge = Array.from({ length: 300 }, (_, i) => `line-${i.toString().padStart(3, "0")}${i === 150 ? " MIDDLE-SENTINEL" : ""}`).join("\n");
	const { prompt, metadata } = serializeProviderContextWithMetadata(contextWithToolResult(huge, "bash"), {
		truncateToolResults: true,
		maxToolResultBytes: 900,
		maxToolResultLines: 20,
		recoveryIdFactory: () => "test-recovery-bash-1",
	});
	assert.match(prompt, /Recovery ID: test-recovery-bash-1/);
	assert.doesNotMatch(prompt, /MIDDLE-SENTINEL/);

	const tools = createToolResultRecoveryCustomTools(metadata.toolResultRecoveryRecords, {
		defaultLineCount: 5,
		maxLineCount: 20,
		maxBytes: 2_000,
	});
	assert.ok(tools);
	const recoveryTool = tools[TOOL_RESULT_RECOVERY_TOOL_NAME] as {
		execute: (args: Record<string, unknown>) => Promise<any> | any;
	};
	const result = await recoveryTool.execute({ id: "test-recovery-bash-1", startLine: 151, lineCount: 1 });
	assert.equal(result.isError, undefined);
	assert.equal(result.structuredContent.id, "test-recovery-bash-1");
	assert.equal(result.structuredContent.startLine, 151);
	assert.equal(result.structuredContent.endLine, 151);
	assert.match(result.content[0].text, /line-150 MIDDLE-SENTINEL/);
	assert.match(result.content[0].text, /Original: 300 lines/);
	assert.match(result.content[0].text, /SHA-256 [a-f0-9]{64}/);

	const pastEnd = await recoveryTool.execute({ id: "test-recovery-bash-1", startLine: 9999 });
	assert.equal(pastEnd.isError, true);
	assert.match(pastEnd.content[0].text, /past the end/);
	assert.equal(pastEnd.structuredContent.returnedBytes, 0);

	const missing = await recoveryTool.execute({ id: "does-not-exist" });
	assert.equal(missing.isError, true);
	assert.equal(missing.structuredContent.found, false);
});

test("recovery custom tool preserves original CRLF line endings in returned slices", async () => {
	const crlfText = Array.from({ length: 120 }, (_, i) => `crlf-line-${i.toString().padStart(3, "0")}`).join("\r\n");
	const { metadata } = serializeProviderContextWithMetadata(contextWithToolResult(crlfText, "read", "call-crlf-1"), {
		truncateToolResults: true,
		maxToolResultBytes: 500,
		maxToolResultLines: 10,
		recoveryIdFactory: () => "test-recovery-crlf-1",
	});
	const tools = createToolResultRecoveryCustomTools(metadata.toolResultRecoveryRecords, {
		defaultLineCount: 5,
		maxLineCount: 20,
		maxBytes: 2_000,
	});
	assert.ok(tools);
	const recoveryTool = tools[TOOL_RESULT_RECOVERY_TOOL_NAME] as {
		execute: (args: Record<string, unknown>) => Promise<any> | any;
	};
	const result = await recoveryTool.execute({ id: "test-recovery-crlf-1", startLine: 51, lineCount: 3 });
	const expectedSlice = "crlf-line-050\r\ncrlf-line-051\r\ncrlf-line-052\r\n";
	assert.match(result.content[0].text, /<recovered_tool_result>/);
	assert.ok(result.content[0].text.includes(expectedSlice), result.content[0].text);
});

test("deterministic recovery IDs are stable across serializations and tied to tool-result identity", () => {
	const huge = Array.from({ length: 200 }, (_, i) => `stable-line-${i} ${"x".repeat(80)}`).join("\n");
	const options = { truncateToolResults: true, maxToolResultBytes: 1_000, maxToolResultLines: 10 };
	const first = serializeProviderContextWithMetadata(contextWithToolResult(huge, "read", "call-stable-1"), options);
	const second = serializeProviderContextWithMetadata(contextWithToolResult(huge, "read", "call-stable-1"), options);
	const changedContent = serializeProviderContextWithMetadata(contextWithToolResult(`${huge}\nchanged`, "read", "call-stable-1"), options);
	const changedCall = serializeProviderContextWithMetadata(contextWithToolResult(huge, "read", "call-stable-2"), options);

	const firstId = first.metadata.truncatedToolResults[0].recoveryId;
	assert.match(firstId ?? "", /^ptr_[a-f0-9]{24}$/);
	assert.equal(second.metadata.truncatedToolResults[0].recoveryId, firstId);
	assert.equal(first.metadata.toolResultRecoveryRecords[0].id, firstId);
	assert.match(first.prompt, new RegExp(`Recovery ID: ${firstId}`));
	assert.equal(
		deterministicToolResultRecoveryId("read", "call-stable-1", first.metadata.truncatedToolResults[0].sha256),
		firstId,
	);
	assert.notEqual(changedContent.metadata.truncatedToolResults[0].recoveryId, firstId);
	assert.notEqual(changedCall.metadata.truncatedToolResults[0].recoveryId, firstId);
});

test("preview preserves head and tail while respecting byte and line content ceilings", () => {
	const preview = previewTextByBytesAndLines("one\ntwo\nthree\nfour", 9, 2);
	assert.equal(preview.truncated, true);
	assert.match(preview.headText, /one/);
	assert.match(preview.tailText, /four/);
	assert.ok(preview.previewLines <= 2);
	assert.ok(preview.previewBytes <= 9);
});

test("env parser uses Pi-sized defaults and accepts common false values", () => {
	assert.deepEqual(providerToolResultSerializationOptionsFromEnv({}), {
		truncateToolResults: true,
		maxToolResultBytes: DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES,
		maxToolResultLines: DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES,
	});
	for (const value of ["0", "false", "no", "off"]) {
		assert.equal(providerToolResultSerializationOptionsFromEnv({ CURSOR_COMPOSER_PROVIDER_TRUNCATE_TOOL_RESULTS: value }).truncateToolResults, false);
	}
	assert.deepEqual(
		providerToolResultSerializationOptionsFromEnv({}, { maxToolResultBytes: 12_345, maxToolResultLines: 678 }),
		{ truncateToolResults: true, maxToolResultBytes: 12_345, maxToolResultLines: 678 },
	);
	assert.equal(DEFAULT_PROVIDER_TOOL_RESULT_MAX_BYTES, 51_200);
	assert.equal(DEFAULT_PROVIDER_TOOL_RESULT_MAX_LINES, 2_000);
});

test("ten-turn provider context keeps conversation structure while truncating large historical tool outputs", () => {
	const messages: Array<{ role: string; content: Array<{ type: string; text: string }>; toolName?: string }> = [];
	for (let turn = 1; turn <= 10; turn += 1) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: `turn-${turn}: inspect evidence and answer with the turn marker` }],
		});
		const toolName = turn % 2 === 0 ? "bash" : "read";
		const tailMarker = toolName === "bash" ? `TURN-${turn}-TAIL-EXIT-STATUS-1` : `TURN-${turn}-TAIL-FILE-END`;
		const toolText = Array.from(
			{ length: 120 },
			(_, line) => `turn-${turn} ${toolName} line-${line.toString().padStart(3, "0")} ${line === 119 ? tailMarker : "x".repeat(60)}`,
		).join("\n");
		messages.push({
			role: "toolResult",
			toolName,
			content: [{ type: "text", text: toolText }],
		});
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `turn-${turn}: evidence acknowledged` }],
		});
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: "final: summarize all ten turns" }],
	});

	const context = { systemPrompt: "system instructions stay visible", messages };
	const baseline = serializeProviderContext(context, { truncateToolResults: false });
	const { prompt, metadata } = serializeProviderContextWithMetadata(context, {
		truncateToolResults: true,
		maxToolResultBytes: 1_000,
		maxToolResultLines: 12,
	});

	assert.ok(prompt.length < baseline.length * 0.3, `expected ten-turn optimized prompt to be <30% of baseline (${prompt.length}/${baseline.length})`);
	assert.equal(metadata.truncatedToolResults.length, 10);
	assert.equal(metadata.truncatedToolResults.filter((item) => item.toolName === "bash").length, 5);
	assert.equal(metadata.truncatedToolResults.filter((item) => item.toolName === "read").length, 5);
	assert.match(prompt, /# Pi system prompt/);
	assert.match(prompt, /final: summarize all ten turns/);
	for (let turn = 1; turn <= 10; turn += 1) {
		assert.match(prompt, new RegExp(`turn-${turn}: inspect evidence`));
		assert.match(prompt, new RegExp(`turn-${turn}: evidence acknowledged`));
		assert.match(prompt, new RegExp(`turn-${turn} (bash|read) line-000`));
		assert.match(prompt, new RegExp(`TURN-${turn}-TAIL-(EXIT-STATUS-1|FILE-END)`));
	}
	assert.match(prompt, /Original SHA-256: [a-f0-9]{64}/);
	assert.match(prompt, /<tool_result_preview_head>/);
	assert.match(prompt, /<tool_result_preview_tail>/);
});
