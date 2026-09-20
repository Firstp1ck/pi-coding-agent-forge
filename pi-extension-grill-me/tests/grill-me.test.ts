import "./register-typescript.mjs";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import grillMeExtension from "../index.ts";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
	details?: { path: string; count?: number; recorded?: number };
};

type Tool = {
	name: string;
	executionMode?: string;
	parameters?: TSchema;
	promptGuidelines?: string[];
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
};

type CommandContext = {
	cwd: string;
	hasUI: boolean;
	mode: string;
	ui: { notify(message: string, level: string): void };
};

type Command = {
	handler: (args: string, ctx: CommandContext) => Promise<void>;
};

type SessionHandler = () => Promise<void> | void;

interface HarnessOptions {
	existingQuestionnaire?: Tool;
	activeTools?: string[];
}

function createHarness(options: HarnessOptions = {}) {
	const tools = new Map<string, Tool>();
	if (options.existingQuestionnaire) tools.set("questionnaire", options.existingQuestionnaire);
	const commands = new Map<string, Command>();
	const sessionHandlers: SessionHandler[] = [];
	const sentMessages: string[] = [];
	const registrations: string[] = [];

	grillMeExtension({
		on(event: string, handler: SessionHandler) {
			if (event === "session_start") sessionHandlers.push(handler);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		registerTool(tool: Tool) {
			registrations.push(tool.name);
			tools.set(tool.name, tool);
		},
		getAllTools() {
			return [...tools.values()];
		},
		getActiveTools() {
			return options.activeTools ?? [...tools.keys()];
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI);

	const command = commands.get("grill-me");
	const recordTurn = tools.get("grill_record_turn");
	const recordBatch = tools.get("grill_record_turns");
	const saveResults = tools.get("grill_save_results");
	assert.ok(command && recordTurn && recordBatch && saveResults, "grill command and tools should be registered");
	return { command, recordTurn, recordBatch, saveResults, tools, sessionHandlers, sentMessages, registrations };
}

function questionnaireStub(): Tool {
	return {
		name: "questionnaire",
		async execute() {
			return { content: [{ type: "text", text: "unused" }] };
		},
	};
}

function commandContext(cwd: string, overrides: Partial<CommandContext> = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx: CommandContext = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
		...overrides,
	};
	return { ctx, notifications };
}

async function readState(cwd: string): Promise<{
	plan: string;
	turns: Array<{ question: string; recommendedAnswer: string; userAnswer?: string; decisionStatus: string }>;
}> {
	return JSON.parse(await readFile(join(cwd, ".pi", "grill-me", "state.json"), "utf8"));
}

async function withTempProject(run: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "grill-me-test-"));
	try {
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("the command emits the model-guided questionnaire round contract", async () => {
	await withTempProject(async (cwd) => {
		const { command, sentMessages } = createHarness({
			existingQuestionnaire: questionnaireStub(),
			activeTools: ["questionnaire"],
		});
		const { ctx } = commandContext(cwd);

		await command.handler("Build a plugin system", ctx);

		assert.equal(sentMessages.length, 1);
		const prompt = sentMessages[0];
		assert.match(prompt, /model-guided interview/i);
		assert.match(prompt, /this protocol replaces generic questionnaire advice to ask in chat after cancellation or unavailability/i);
		assert.match(prompt, /Investigate codebase-answerable facts before asking the user/i);
		assert.match(prompt, /currently answerable, independent user decision.*up to 20 questions/i);
		assert.match(prompt, /Every initial or follow-up user decision must use questionnaire/i);
		assert.match(prompt, /stable IDs, usable choices, allowOther true, and a recommendation/i);
		assert.match(prompt, /Do not request passwords, tokens, or other secrets/i);
		assert.match(prompt, /resume with the exact questionnaireId and revision/i);
		assert.match(prompt, /Do not restart the questionnaire or infer the pending answer/i);
		assert.match(prompt, /call grill_record_turns once with all newly returned explicit answers in its turns array, in questionnaire order/i);
		assert.match(prompt, /Do not split a questionnaire round into separate grill_record_turn calls/i);
		assert.match(prompt, /If no new explicit answers were returned, skip recording rather than sending an empty batch/i);
		assert.match(prompt, /Do not record the same answer twice after a resume/i);
		assert.match(prompt, /include every selected label plus any custom Other value in userAnswer/i);
		assert.match(prompt, /A completed questionnaire finishes only that round/i);
		assert.match(prompt, /Evaluate the answers for conflicts, changed assumptions, and remaining ambiguity/i);
		assert.match(prompt, /If questionnaire returns cancelled or unavailable, do not reopen it and do not ask in chat/i);
		assert.match(prompt, /Save the answered decisions as partial results with remaining ambiguities/i);
		assert.match(prompt, /Never claim full resolution after cancellation, unavailability, or a postponed decision/i);
		assert.doesNotMatch(prompt, /Plan intake:/);
		assert.equal((await readState(cwd)).plan, "Build a plugin system");
	});
});

test("the command starts in RPC mode when questionnaire is active", async () => {
	await withTempProject(async (cwd) => {
		const { command, sentMessages } = createHarness({
			existingQuestionnaire: questionnaireStub(),
			activeTools: ["questionnaire"],
		});
		const { ctx, notifications } = commandContext(cwd, { mode: "rpc" });

		await command.handler("Review the RPC workflow", ctx);

		assert.equal(sentMessages.length, 1);
		assert.equal((await readState(cwd)).plan, "Review the RPC workflow");
		assert.equal(notifications[0]?.level, "info");
	});
});

test("a missing plan starts questionnaire intake and the first explicit answer becomes the plan", async () => {
	await withTempProject(async (cwd) => {
		const { command, recordTurn, sentMessages } = createHarness({
			existingQuestionnaire: questionnaireStub(),
			activeTools: ["questionnaire"],
		});
		const { ctx } = commandContext(cwd);

		await command.handler("   ", ctx);

		assert.equal(sentMessages.length, 1);
		const prompt = sentMessages[0];
		assert.match(prompt, /first user-facing question must be a questionnaire start call with one single-select question/i);
		assert.match(prompt, /offer an option whose label names that plan/i);
		assert.match(prompt, /Keep allowOther true so the user can describe a plan/i);
		assert.match(prompt, /Do not ask for the plan in ordinary chat and do not invent one/i);
		assert.match(prompt, /record the resolved plan-intake answer first with grill_record_turns containing one entry and an explicit userAnswer, before recording any other turn/i);
		assert.match(prompt, /Until that answer is recorded, do not record codebase discoveries, open questions, or other decisions/i);
		assert.match(prompt, /If the user chose to stop, save partial results and end the interview/i);
		assert.equal((await readState(cwd)).plan, "(No plan supplied; collect it through questionnaire intake.)");

		await recordTurn.execute("intake", {
			question: "Which plan should Grill Me explore?",
			recommendedAnswer: "Use existing plan: plugin system",
			userAnswer: "Other: Add offline synchronization",
			decisionStatus: "resolved",
		}, undefined, undefined, { cwd });

		const state = await readState(cwd);
		assert.equal(state.plan, "Other: Add offline synchronization");
		assert.equal(state.turns[0]?.userAnswer, "Other: Add offline synchronization");

		await recordTurn.execute("discovery", {
			question: "Which language does the project use?",
			recommendedAnswer: "Use the existing project language.",
			userAnswer: "TypeScript",
			decisionStatus: "resolved",
		}, undefined, undefined, { cwd });
		assert.equal((await readState(cwd)).plan, "Other: Add offline synchronization");
	});
});

test("availability guards leave existing state untouched and send no kickoff", async (t) => {
	const cases: Array<{
		name: string;
		harness: HarnessOptions;
		context: Partial<CommandContext>;
		error: RegExp;
	}> = [
		{
			name: "no UI",
			harness: { existingQuestionnaire: questionnaireStub(), activeTools: ["questionnaire"] },
			context: { hasUI: false, mode: "print" },
			error: /requires questionnaire UI in TUI or RPC mode/i,
		},
		{
			name: "unsupported mode",
			harness: { existingQuestionnaire: questionnaireStub(), activeTools: ["questionnaire"] },
			context: { hasUI: true, mode: "json" },
			error: /requires questionnaire UI in TUI or RPC mode/i,
		},
		{
			name: "missing questionnaire tool",
			harness: { activeTools: [] },
			context: {},
			error: /could not find the questionnaire tool/i,
		},
		{
			name: "inactive questionnaire tool",
			harness: { existingQuestionnaire: questionnaireStub(), activeTools: [] },
			context: {},
			error: /questionnaire tool, but it is disabled/i,
		},
	];

	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			await withTempProject(async (cwd) => {
				const statePath = join(cwd, ".pi", "grill-me", "state.json");
				const originalState = "{\n  \"existing\": true\n}\n";
				await mkdir(join(cwd, ".pi", "grill-me"), { recursive: true });
				await writeFile(statePath, originalState, "utf8");
				const { command, sentMessages } = createHarness(scenario.harness);
				const { ctx, notifications } = commandContext(cwd, scenario.context);

				await command.handler("Replacement plan", ctx);

				assert.equal(await readFile(statePath, "utf8"), originalState);
				assert.deepEqual(sentMessages, []);
				assert.equal(notifications.length, 1);
				assert.equal(notifications[0]?.level, "error");
				assert.match(notifications[0]?.message ?? "", scenario.error);
			});
		});
	}
});

test("the bundled questionnaire registers once when no questionnaire exists", async () => {
	const harness = createHarness();
	assert.equal(harness.sessionHandlers.length, 1);
	assert.equal(harness.tools.has("questionnaire"), false);

	await harness.sessionHandlers[0]();
	const registered = harness.tools.get("questionnaire");
	assert.ok(registered, "session start should register the bundled questionnaire");
	assert.equal(harness.registrations.filter((name) => name === "questionnaire").length, 1);

	await harness.sessionHandlers[0]();
	assert.equal(harness.tools.get("questionnaire"), registered);
	assert.equal(harness.registrations.filter((name) => name === "questionnaire").length, 1);
});

test("an existing questionnaire tool wins coexistence without duplicate registration", async () => {
	const existingQuestionnaire = questionnaireStub();
	const harness = createHarness({ existingQuestionnaire, activeTools: ["questionnaire"] });

	await harness.sessionHandlers[0]();
	await harness.sessionHandlers[0]();

	assert.equal(harness.tools.get("questionnaire"), existingQuestionnaire);
	assert.equal(harness.registrations.filter((name) => name === "questionnaire").length, 0);
});

test("package metadata wires the exact bundled questionnaire dependency", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(packageJson.dependencies?.["@firstpick/pi-package-questionnaire"], "0.1.1");
	assert.deepEqual(packageJson.bundledDependencies, ["@firstpick/pi-package-questionnaire"]);
	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
});

test("resolved multi-select and custom answers persist separately and in order", async () => {
	await withTempProject(async (cwd) => {
		const { command, recordTurn, saveResults } = createHarness({
			existingQuestionnaire: questionnaireStub(),
			activeTools: ["questionnaire"],
		});
		assert.equal(recordTurn.executionMode, "sequential");
		await command.handler("Choose release behavior", commandContext(cwd).ctx);

		await recordTurn.execute("targets", {
			question: "Which release targets are required?",
			recommendedAnswer: "Web and CLI cover current users.",
			userAnswer: "Web; CLI; Other: IDE plugin",
			decisionStatus: "resolved",
		}, undefined, undefined, { cwd });
		await recordTurn.execute("cadence", {
			question: "What release cadence should we use?",
			recommendedAnswer: "Choose weekly releases.",
			userAnswer: "Other: Release after each accepted change",
			decisionStatus: "resolved",
		}, undefined, undefined, { cwd });

		const state = await readState(cwd);
		assert.deepEqual(state.turns.map((turn) => ({
			question: turn.question,
			recommendedAnswer: turn.recommendedAnswer,
			userAnswer: turn.userAnswer,
		})), [
			{
				question: "Which release targets are required?",
				recommendedAnswer: "Web and CLI cover current users.",
				userAnswer: "Web; CLI; Other: IDE plugin",
			},
			{
				question: "What release cadence should we use?",
				recommendedAnswer: "Choose weekly releases.",
				userAnswer: "Other: Release after each accepted change",
			},
		]);

		await saveResults.execute("save", {}, undefined, undefined, { cwd });
		const markdown = await readFile(join(cwd, "GRILL-ME.md"), "utf8");
		assert.match(markdown, /\*\*User answer:\*\* Web; CLI; Other: IDE plugin/);
		assert.match(markdown, /\*\*User answer:\*\* Other: Release after each accepted change/);
	});
});

test("a resolved turn without a user answer is rejected instead of saving a placeholder", async () => {
	for (const userAnswer of [undefined, "   "]) {
		await withTempProject(async (cwd) => {
			const { recordTurn } = createHarness();
			await assert.rejects(recordTurn.execute("test", {
				question: "How should results be displayed?",
				recommendedAnswer: "A: Detailed",
				...(userAnswer === undefined ? {} : { userAnswer }),
				decisionStatus: "resolved",
				notes: "User chose detailed display.",
			}, undefined, undefined, { cwd }), /userAnswer is required for resolved turns/i);
			await assert.rejects(readFile(join(cwd, ".pi", "grill-me", "state.json"), "utf8"), { code: "ENOENT" });
		});
	}
});

test("an explicit user answer is preserved in saved results", async () => {
	await withTempProject(async (cwd) => {
		const { recordTurn, saveResults } = createHarness();
		const recordResult = await recordTurn.execute("test", {
			question: "How should results be displayed?",
			recommendedAnswer: "A: Detailed",
			userAnswer: "A: Detailed",
			decisionStatus: "resolved",
			notes: "User chose detailed display.",
		}, undefined, undefined, { cwd });
		assert.equal(recordResult.isError, undefined);

		const saveResult = await saveResults.execute("test", {}, undefined, undefined, { cwd });
		assert.equal(saveResult.isError, undefined);
		const markdown = await readFile(join(cwd, "GRILL-ME.md"), "utf8");
		assert.match(markdown, /\*\*User answer:\*\* A: Detailed/);
		assert.doesNotMatch(markdown, /\*\*User answer:\*\* _\(not recorded\)_/);
	});
});

function answeredTurn(index: number) {
	return {
		question: `Question ${index}?`,
		recommendedAnswer: `Recommendation ${index}`,
		userAnswer: `Answer ${index}`,
		decisionStatus: "resolved",
	};
}

test("one batch preserves ordered answers, notes, and separate Markdown decisions", async () => {
	await withTempProject(async (cwd) => {
		const { recordBatch, saveResults } = createHarness();
		assert.equal(recordBatch.executionMode, "sequential");
		const turns = [
			{ ...answeredTurn(1), userAnswer: "  Web; CLI; Other: IDE plugin  ", notes: "All targets selected." },
			{ ...answeredTurn(2), userAnswer: "Other: After each accepted change" },
			{ ...answeredTurn(3), userAnswer: undefined, decisionStatus: "open" },
			{ ...answeredTurn(4), userAnswer: undefined, decisionStatus: "needs-codebase-check" },
		];
		const result = await recordBatch.execute("round", { turns }, undefined, undefined, { cwd });
		assert.equal(result.content[0]?.text, "Recorded 4 grill turns (#1–#4)");
		assert.deepEqual(result.details, {
			path: join(cwd, ".pi", "grill-me", "state.json"), count: 4, recorded: 4,
		});
		assert.deepEqual((await readState(cwd)).turns, JSON.parse(JSON.stringify(
			turns.map((turn) => ({ ...turn, userAnswer: turn.userAnswer?.trim() })),
		)));
		await saveResults.execute("save", {}, undefined, undefined, { cwd });
		const markdown = await readFile(join(cwd, "GRILL-ME.md"), "utf8");
		assert.deepEqual([...markdown.matchAll(/^### \d+\. (.+)$/gm)].map((match) => match[1]), turns.map((turn) => turn.question));
		assert.match(markdown, /\*\*User answer:\*\* Web; CLI; Other: IDE plugin/);
		assert.match(markdown, /\*\*Notes:\*\* All targets selected\./);
		assert.match(markdown, /\*\*Status:\*\* needs-codebase-check/);
	});
});

test("batch limits and entry shapes are enforced in schema and execution", async () => {
	await withTempProject(async (cwd) => {
		const { recordBatch } = createHarness();
		assert.ok(recordBatch.parameters);
		const valid = Array.from({ length: 20 }, (_, index) => answeredTurn(index + 1));
		assert.equal(Check(recordBatch.parameters, { turns: valid }), true);
		for (const turns of [
			[], [...valid, answeredTurn(21)], null, "answers", [null],
			[{ ...answeredTurn(1), question: undefined }],
			[{ ...answeredTurn(1), recommendedAnswer: 3 }],
			[{ ...answeredTurn(1), decisionStatus: "unknown" }],
			[{ ...answeredTurn(1), userAnswer: 42 }],
			[{ ...answeredTurn(1), notes: false }],
		]) {
			assert.equal(Check(recordBatch.parameters, { turns }), false);
			await assert.rejects(recordBatch.execute("invalid", { turns }, undefined, undefined, { cwd }), /Expected 1–20 turns/);
		}
		await assert.rejects(readState(cwd), { code: "ENOENT" });
		await recordBatch.execute("maximum", { turns: valid }, undefined, undefined, { cwd });
		assert.deepEqual((await readState(cwd)).turns, valid);
	});
});

test("a later invalid answer rejects the entire batch without creating or changing state", async () => {
	for (const existing of [false, true]) {
		for (const userAnswer of [undefined, "   "]) {
			await withTempProject(async (cwd) => {
				const { recordTurn, recordBatch } = createHarness();
				const path = join(cwd, ".pi", "grill-me", "state.json");
				if (existing) await recordTurn.execute("existing", answeredTurn(1), undefined, undefined, { cwd });
				const before = existing ? await readFile(path, "utf8") : undefined;
				await assert.rejects(recordBatch.execute("invalid", { turns: [
					answeredTurn(2), { ...answeredTurn(3), userAnswer, notes: "Notes are not an answer." },
				] }, undefined, undefined, { cwd }), /Turn #2: userAnswer is required.*No turns were recorded/);
				if (existing) assert.equal(await readFile(path, "utf8"), before);
				else await assert.rejects(readFile(path), { code: "ENOENT" });
			});
		}
	}
});

test("batch plan intake sets the plan once and remains compatible with single recording", async () => {
	await withTempProject(async (cwd) => {
		const { command, recordBatch, recordTurn } = createHarness({ existingQuestionnaire: questionnaireStub() });
		await command.handler("", commandContext(cwd).ctx);
		await recordBatch.execute("intake", { turns: [{
			...answeredTurn(1), userAnswer: "  Other: Add offline synchronization  ",
		}] }, undefined, undefined, { cwd });
		const single = await recordTurn.execute("discovery", answeredTurn(2), undefined, undefined, { cwd });
		assert.equal(single.content[0]?.text, "Recorded grill turn #2");
		const batch = await recordBatch.execute("follow-up", { turns: [answeredTurn(3), answeredTurn(4)] }, undefined, undefined, { cwd });
		assert.equal(batch.content[0]?.text, "Recorded 2 grill turns (#3–#4)");
		const state = await readState(cwd);
		assert.equal(state.plan, "Other: Add offline synchronization");
		assert.deepEqual(state.turns.map((turn) => turn.question), [1, 2, 3, 4].map((index) => `Question ${index}?`));
	});
});

test("recording mutations share a queue so concurrent single and batch calls retain all turns", async () => {
	await withTempProject(async (cwd) => {
		const { recordTurn, recordBatch } = createHarness();
		await Promise.all([
			recordBatch.execute("first", { turns: [answeredTurn(1), answeredTurn(2)] }, undefined, undefined, { cwd }),
			recordTurn.execute("single", answeredTurn(3), undefined, undefined, { cwd }),
			recordBatch.execute("second", { turns: [answeredTurn(4), answeredTurn(5)] }, undefined, undefined, { cwd }),
		]);
		const questions = (await readState(cwd)).turns.map((turn) => turn.question);
		assert.equal(questions.length, 5);
		assert.deepEqual([...questions].sort(), [1, 2, 3, 4, 5].map((index) => `Question ${index}?`));
		assert.equal(questions.indexOf("Question 2?"), questions.indexOf("Question 1?") + 1);
		assert.equal(questions.indexOf("Question 5?"), questions.indexOf("Question 4?") + 1);
	});
});

test("tool guidance prefers one batch per questionnaire result rather than repeated single calls", () => {
	const { recordTurn, recordBatch } = createHarness();
	assert.match(recordTurn.promptGuidelines?.join("\n") ?? "", /prefer grill_record_turns for questionnaire rounds/);
	const guidance = recordBatch.promptGuidelines?.join("\n") ?? "";
	assert.match(guidance, /completed, cancelled, or unavailable.*one grill_record_turns call/);
	assert.match(guidance, /skip it if there are none/);
	assert.match(guidance, /Do not repeat answers already recorded/);
	assert.match(guidance, /preserve all selections and custom Other text/);
});
