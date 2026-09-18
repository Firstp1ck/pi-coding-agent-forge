import "./register-typescript.mjs";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import grillMeExtension from "../index.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
};

type Tool = {
	name: string;
	executionMode?: string;
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
	const saveResults = tools.get("grill_save_results");
	assert.ok(command && recordTurn && saveResults, "grill command and tools should be registered");
	return { command, recordTurn, saveResults, tools, sessionHandlers, sentMessages, registrations };
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
		assert.match(prompt, /call grill_record_turn once for each newly returned explicit answer, in questionnaire order/i);
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
		assert.match(prompt, /record the resolved plan-intake answer first with grill_record_turn and an explicit userAnswer, before recording any other turn/i);
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
			const result = await recordTurn.execute("test", {
				question: "How should results be displayed?",
				recommendedAnswer: "A: Detailed",
				...(userAnswer === undefined ? {} : { userAnswer }),
				decisionStatus: "resolved",
				notes: "User chose detailed display.",
			}, undefined, undefined, { cwd });

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /userAnswer is required for resolved turns/i);
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
