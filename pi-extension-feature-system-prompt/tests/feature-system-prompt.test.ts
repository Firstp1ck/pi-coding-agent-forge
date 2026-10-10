import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import featureSystemPrompt, {
	buildClassifierPrompt,
	buildFeatureClassificationContext,
	CLASSIFIER_TIMEOUT_MS,
	classifyObviousNonFeatureRequest,
	createFeatureSystemPrompt,
	FEATURE_CATEGORY_STATUS_KEY,
	FEATURE_CLASSIFICATION_FALLBACK,
	FEATURE_DECISION_OUTPUT_STATUS_KEY,
	FEATURE_SKILL_CONFIGURATION_ERROR,
	FEATURE_SKILL_NAME,
	FEATURE_SKILL_ROUTING_BRIDGE,
	featureSkillIsAvailable,
	getFeatureComplexity,
	isLikelyContinuation,
	isPiSubagentChild,
	MAX_CLASSIFIER_PROMPT_CHARS,
	MAX_CLASSIFIER_REASON_CHARS,
	parseClassifierDecision,
	parseRequestKind,
	REQUEST_KINDS,
	resolveRequestKind,
	shouldInjectFeaturePrompt,
	type ActiveClassifierModel,
	type ClassifierDecision,
	type ClassifierPromptInput,
	type FeatureSystemPromptDependencies,
	type RequestKind,
} from "../feature-system-prompt.ts";

type BeforeAgentStartEvent = { prompt: string; systemPrompt: string };
type BeforeAgentStartResult = { systemPrompt: string } | undefined;
type TestContext = Pick<ExtensionContext, "model" | "mode" | "ui">;
type BeforeAgentStartHandler = (event: BeforeAgentStartEvent, ctx: TestContext) => Promise<BeforeAgentStartResult>;
type LifecycleHandler = (event: unknown, ctx: TestContext) => void;
type StatusUpdate = { key: string; text: string | undefined };

const ACTIVE_MODEL = { provider: "local-provider", id: "active-conversation-model" } as ActiveClassifierModel;

function classifierDecision(kind: RequestKind, reason = `The request is classified as ${kind}.`): ClassifierDecision {
	return { kind, reason };
}

function createFeaturePromptHarness(dependencies: FeatureSystemPromptDependencies) {
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	const lifecycleHandlers = new Map<string, LifecycleHandler>();
	const statusUpdates: StatusUpdate[] = [];
	const createContext = (model: ActiveClassifierModel | undefined, mode: ExtensionContext["mode"]): TestContext => ({
		model,
		mode,
		ui: {
			setStatus(key: string, text: string | undefined) {
				statusUpdates.push({ key, text });
			},
		} as ExtensionContext["ui"],
	});
	createFeatureSystemPrompt({ validateFeatureSkill: () => true, ...dependencies })({
		on(name: string, candidate: unknown) {
			if (name === "before_agent_start") beforeAgentStart = candidate as BeforeAgentStartHandler;
			else lifecycleHandlers.set(name, candidate as LifecycleHandler);
		},
	} as unknown as ExtensionAPI);

	if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered");
	return {
		beforeAgentStart,
		lifecycleHandlers,
		statusUpdates,
		run(prompt: string) {
			return beforeAgentStart({ prompt, systemPrompt: "BASE" }, createContext(ACTIVE_MODEL, "tui"));
		},
		runInRpcMode(prompt: string) {
			return beforeAgentStart({ prompt, systemPrompt: "BASE" }, createContext(ACTIVE_MODEL, "rpc"));
		},
		runWithoutModel(prompt: string, mode: ExtensionContext["mode"] = "tui") {
			return beforeAgentStart({ prompt, systemPrompt: "BASE" }, createContext(undefined, mode));
		},
		runLifecycle(name: string, mode: ExtensionContext["mode"] = "tui") {
			const handler = lifecycleHandlers.get(name);
			if (!handler) throw new Error(`${name} handler was not registered`);
			handler({}, createContext(ACTIVE_MODEL, mode));
		},
	};
}

function injectedFeaturePrompt(kind: "feature_lightweight" | "feature_complex") {
	return `BASE\n\n${buildFeatureClassificationContext(kind)}\n\n${FEATURE_SKILL_ROUTING_BRIDGE}`;
}

test("the taxonomy has every approved label and parses only exact labels", () => {
	assert.deepEqual(REQUEST_KINDS, [
		"feature_lightweight",
		"feature_complex",
		"bug",
		"refactor",
		"maintenance",
		"documentation",
		"test",
		"planning",
		"research",
		"review",
		"troubleshooting",
		"operations",
		"question",
		"continuation",
		"other",
	]);

	for (const kind of REQUEST_KINDS) assert.equal(parseRequestKind(kind), kind);
	for (const output of ["", "feature", "Feature", " feature_lightweight", "feature_complex ", "feature_lightweight\n", "feature_complex.", "feature_lightweight\nbug"]) {
		assert.equal(parseRequestKind(output), undefined, output);
	}
});

test("structured classifier decisions require exact JSON fields and normalize bounded plain-text reasons", () => {
	assert.deepEqual(
		parseClassifierDecision('{"kind":"feature_complex","reason":"  Adds a UI flow.\\nCrosses an interface.\\u202eSpoofed direction.  "}'),
		{ kind: "feature_complex", reason: "Adds a UI flow. Crosses an interface. Spoofed direction." },
	);
	assert.deepEqual(
		parseClassifierDecision(JSON.stringify({ kind: "feature_lightweight", reason: "r".repeat(MAX_CLASSIFIER_REASON_CHARS + 20) })),
		{ kind: "feature_lightweight", reason: "r".repeat(MAX_CLASSIFIER_REASON_CHARS) },
	);

	for (const output of [
		"feature_lightweight",
		'{"kind":"feature_lightweight"}',
		'{"kind":"feature_lightweight","reason":""}',
		'{"kind":"feature_lightweight","reason":"   \\n  "}',
		'{"kind":"feature_lightweight","reason":1}',
		'{"kind":"feature_lightweight","reason":"Valid.","extra":true}',
		'{"kind":"unknown","reason":"Valid."}',
		'```json\\n{"kind":"feature_lightweight","reason":"Valid."}\\n```',
	]) assert.equal(parseClassifierDecision(output), undefined, output);
});

test("continuation resolution inherits only a known effective kind", () => {
	assert.equal(resolveRequestKind("continuation", "feature_lightweight"), "feature_lightweight");
	assert.equal(resolveRequestKind("continuation", "feature_complex"), "feature_complex");
	assert.equal(resolveRequestKind("continuation", "bug"), "bug");
	assert.equal(resolveRequestKind("continuation", undefined), "other");
	assert.equal(resolveRequestKind("refactor", "feature_complex"), "refactor");
});

test("the continuation signal is conservative and exported", () => {
	for (const prompt of ["Continue", "Continue with that implementation", "go on", "Yes, please continue", "Approved", "Fix it"]) {
		assert.equal(isLikelyContinuation(prompt), true, prompt);
	}
	for (const prompt of ["Add a command palette", "Explain this error", "I approve a new deployment plan", "continue by writing a full proposal with alternatives", "x".repeat(241)]) {
		assert.equal(isLikelyContinuation(prompt), false, prompt);
	}
});

test("the local fast path accepts only explicit non-feature work", () => {
	assert.equal(classifyObviousNonFeatureRequest("sending a prompt has a delay; find and solve the rootcause"), "bug");
	assert.equal(classifyObviousNonFeatureRequest("Review this diff"), "review");
	assert.equal(classifyObviousNonFeatureRequest("Research current package managers"), "research");
	assert.equal(classifyObviousNonFeatureRequest("Explain the existing API"), "question");
	assert.equal(classifyObviousNonFeatureRequest("Troubleshoot this network problem"), "troubleshooting");

	for (const prompt of [
		"Add a command palette",
		"Implement a fix for this bug",
		"Build support for retries",
		"How do we add a command palette?",
		"",
	]) assert.equal(classifyObviousNonFeatureRequest(prompt), undefined, prompt);
});

test("classifier prompt is bounded and current-only by default", () => {
	const current = `${"c".repeat(MAX_CLASSIFIER_PROMPT_CHARS)}CURRENT-TAIL`;
	const previous = `${"p".repeat(MAX_CLASSIFIER_PROMPT_CHARS)}PREVIOUS-TAIL`;
	const currentOnly = buildClassifierPrompt({ prompt: current });
	assert.ok(currentOnly.includes(JSON.stringify(`${"c".repeat(MAX_CLASSIFIER_PROMPT_CHARS - 1)}…`)));
	assert.ok(!currentOnly.includes("Previous request"));
	assert.ok(!currentOnly.includes("CURRENT-TAIL"));

	const withContinuation = buildClassifierPrompt({
		prompt: current,
		previousPrompt: previous,
		previousEffectiveKind: "feature_complex",
	});
	assert.ok(withContinuation.includes(JSON.stringify(`${"p".repeat(MAX_CLASSIFIER_PROMPT_CHARS - 1)}…`)));
	assert.ok(withContinuation.includes("Previous effective kind: feature_complex"));
	assert.ok(withContinuation.includes("use only for continuation detection"));
	assert.ok(!withContinuation.includes("PREVIOUS-TAIL"));
});

test("feature complexity and injection are limited to successful feature labels", () => {
	assert.equal(getFeatureComplexity("feature_lightweight"), "lightweight");
	assert.equal(getFeatureComplexity("feature_complex"), "complex");
	assert.equal(getFeatureComplexity("bug"), undefined);
	for (const kind of REQUEST_KINDS) {
		assert.equal(shouldInjectFeaturePrompt(kind), kind === "feature_lightweight" || kind === "feature_complex", kind);
	}
	assert.equal(shouldInjectFeaturePrompt(undefined), false);
	assert.match(buildFeatureClassificationContext("feature_lightweight"), /`lightweight` feature/);
	assert.match(buildFeatureClassificationContext("feature_complex"), /`complex` feature/);
	assert.throws(() => buildFeatureClassificationContext("question"), /requires a feature result/);
});

test("the handler model-routes ambiguous work but locally resolves obvious non-features and known continuations", async () => {
	const classifierInputs: ClassifierPromptInput[] = [];
	const classifierModels: ActiveClassifierModel[] = [];
	const harness = createFeaturePromptHarness({
		classifyRequest: async (input, model) => {
			classifierInputs.push(input);
			classifierModels.push(model);
			return classifierDecision("feature_complex", "The request adds a broad command palette.");
		},
	});

	assert.deepEqual(await harness.run("Add a command palette"), { systemPrompt: injectedFeaturePrompt("feature_complex") });
	assert.deepEqual(await harness.run("Continue with that implementation"), { systemPrompt: injectedFeaturePrompt("feature_complex") });
	assert.equal(await harness.run("Explain the existing API"), undefined);
	assert.equal(await harness.run("Continue"), undefined);

	assert.deepEqual(classifierModels, [ACTIVE_MODEL]);
	assert.deepEqual(classifierInputs, [{ prompt: "Add a command palette" }]);
});

test("a continuation without known local state still uses the active model without leaking prior text", async () => {
	const classifierInputs: ClassifierPromptInput[] = [];
	const harness = createFeaturePromptHarness({
		classifyRequest: async (input) => {
			classifierInputs.push(input);
			return classifierDecision("continuation", "The request continues the previous task.");
		},
	});
	assert.equal(await harness.run("Continue"), undefined);
	assert.deepEqual(classifierInputs, [{ prompt: "Continue" }]);
});

test("successful feature and non-feature routing injects only the appropriate policy", async () => {
	const classifications: ClassifierDecision[] = [
		classifierDecision("feature_lightweight"),
		classifierDecision("review"),
	];
	const harness = createFeaturePromptHarness({
		classifyRequest: async () => classifications.shift(),
	});

	assert.deepEqual(await harness.run("Add a focused command"), { systemPrompt: injectedFeaturePrompt("feature_lightweight") });
	assert.equal(await harness.run("Review this diff"), undefined);
});

test("RPC mode publishes a structured feature decision before category, reuses it for continuations, and clears both for non-features", async () => {
	const lightweightDecision = classifierDecision("feature_lightweight", "Adds one localized command.");
	const complexDecision = classifierDecision("feature_complex", "Crosses the command and rendering interfaces.");
	const classifications: ClassifierDecision[] = [lightweightDecision, lightweightDecision, complexDecision];
	const classifierInputs: ClassifierPromptInput[] = [];
	const harness = createFeaturePromptHarness({
		classifyRequest: async (input) => {
			classifierInputs.push(input);
			return classifications.shift();
		},
	});

	await harness.run("Add a focused command");
	assert.deepEqual(harness.statusUpdates, []);
	await harness.runInRpcMode("Add a focused command");
	await harness.runInRpcMode("Continue");
	await harness.runInRpcMode("Add a broader command");
	await harness.runInRpcMode("Continue");
	await harness.runInRpcMode("Review this diff");

	assert.deepEqual(classifierInputs, [
		{ prompt: "Add a focused command" },
		{ prompt: "Add a focused command" },
		{ prompt: "Add a broader command" },
	]);
	assert.deepEqual(harness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: JSON.stringify(lightweightDecision) },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: "lightweight-feature" },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: JSON.stringify(lightweightDecision) },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: "lightweight-feature" },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: JSON.stringify(complexDecision) },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: "complex-feature" },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: JSON.stringify(complexDecision) },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: "complex-feature" },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);
});

test("TUI mode does not publish feature statuses", async () => {
	const harness = createFeaturePromptHarness({ classifyRequest: async () => classifierDecision("feature_complex") });
	await harness.run("Add a broader command");
	assert.deepEqual(harness.statusUpdates, []);
});

test("RPC mode clears decision output and category after unavailable classification, missing models, and lifecycle resets", async () => {
	const invalidHarness = createFeaturePromptHarness({ classifyRequest: async () => undefined });
	await invalidHarness.runInRpcMode("Do some work");
	assert.deepEqual(invalidHarness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);

	const throwingHarness = createFeaturePromptHarness({
		classifyRequest: async () => {
			throw new Error("classifier unavailable");
		},
	});
	await throwingHarness.runInRpcMode("Do some work");
	assert.deepEqual(throwingHarness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);

	const noModelHarness = createFeaturePromptHarness({});
	await noModelHarness.runWithoutModel("Do some work", "rpc");
	noModelHarness.runLifecycle("session_start", "rpc");
	noModelHarness.runLifecycle("session_tree", "rpc");
	assert.deepEqual(noModelHarness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);
});

test("RPC lifecycle resets clear a stored structured feature decision output", async () => {
	const complexDecision = classifierDecision("feature_complex", "Adds multiple coordinated slices.");
	const harness = createFeaturePromptHarness({ classifyRequest: async () => complexDecision });
	await harness.runInRpcMode("Add a broader command");
	harness.runLifecycle("session_start", "rpc");
	harness.runLifecycle("session_tree", "rpc");
	assert.deepEqual(harness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: JSON.stringify(complexDecision) },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: "complex-feature" },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);
});

test("classifier invalid output, throw, and no active model inject only the short fallback", async () => {
	const invalidHarness = createFeaturePromptHarness({
		classifyRequest: async () => undefined,
	});
	assert.deepEqual(await invalidHarness.run("Do some work"), { systemPrompt: `BASE\n\n${FEATURE_CLASSIFICATION_FALLBACK}` });

	const throwingHarness = createFeaturePromptHarness({
		classifyRequest: async () => {
			throw new Error("classifier unavailable");
		},
	});
	assert.deepEqual(await throwingHarness.run("Do some work"), { systemPrompt: `BASE\n\n${FEATURE_CLASSIFICATION_FALLBACK}` });

	let classifierCalls = 0;
	const noModelHarness = createFeaturePromptHarness({
		classifyRequest: async () => {
			classifierCalls += 1;
			return classifierDecision("feature_complex");
		},
	});
	assert.deepEqual(await noModelHarness.runWithoutModel("Do some work"), { systemPrompt: `BASE\n\n${FEATURE_CLASSIFICATION_FALLBACK}` });
	assert.equal(classifierCalls, 0);
	assert.ok(!FEATURE_CLASSIFICATION_FALLBACK.includes("## Feature Request Classification"));
	assert.ok(FEATURE_CLASSIFICATION_FALLBACK.includes(`load and follow the enabled \`${FEATURE_SKILL_NAME}\` skill`));
	assert.match(FEATURE_CLASSIFICATION_FALLBACK, /stop feature implementation and report the configuration error/);
});

test("child subagent sessions skip parent-only feature routing when skills are intentionally stripped", async () => {
	let classifierCalls = 0;
	let validatorCalls = 0;
	const harness = createFeaturePromptHarness({
		isSubagentChild: () => true,
		classifyRequest: async () => {
			classifierCalls += 1;
			return classifierDecision("feature_complex");
		},
		validateFeatureSkill: () => {
			validatorCalls += 1;
			return false;
		},
	});

	assert.equal(await harness.run("Implement the approved feature plan"), undefined);
	assert.equal(await harness.runInRpcMode("Continue with the implementation"), undefined);
	assert.equal(classifierCalls, 0);
	assert.equal(validatorCalls, 0);
	assert.deepEqual(harness.statusUpdates, [
		{ key: FEATURE_DECISION_OUTPUT_STATUS_KEY, text: undefined },
		{ key: FEATURE_CATEGORY_STATUS_KEY, text: undefined },
	]);
	assert.equal(isPiSubagentChild({ PI_SUBAGENT_CHILD: "1" }), true);
	assert.equal(isPiSubagentChild({ PI_SUBAGENT_CHILD: "0" }), false);
	assert.equal(isPiSubagentChild({}), false);
});

test("a successful classified feature injects a fail-closed skill-routing bridge", async () => {
	const harness = createFeaturePromptHarness({
		classifyRequest: async () => classifierDecision("feature_lightweight"),
	});
	assert.deepEqual(await harness.run("Add a command palette"), {
		systemPrompt: injectedFeaturePrompt("feature_lightweight"),
	});
	assert.ok(FEATURE_SKILL_ROUTING_BRIDGE.includes(`read to load and follow the enabled \`${FEATURE_SKILL_NAME}\` skill`));
	assert.match(FEATURE_SKILL_ROUTING_BRIDGE, /references\/COMPLEX-FEATURE-CONTRACT\.md/);
	assert.match(FEATURE_SKILL_ROUTING_BRIDGE, /stop feature implementation and report the configuration error/);
	assert.match(FEATURE_SKILL_ROUTING_BRIDGE, /do not silently weaken a required gate/);

	const unavailableHarness = createFeaturePromptHarness({
		classifyRequest: async () => classifierDecision("feature_complex"),
		validateFeatureSkill: () => false,
	});
	assert.deepEqual(await unavailableHarness.run("Add a command palette"), {
		systemPrompt: `BASE\n\n${buildFeatureClassificationContext("feature_complex")}\n\n${FEATURE_SKILL_CONFIGURATION_ERROR}`,
	});
	assert.match(FEATURE_SKILL_CONFIGURATION_ERROR, /Do not implement feature work until the skill configuration is restored/);
});

test("feature routing accepts available T3 delegation without waiving mandatory outcomes", async () => {
	for (const kind of ["feature_lightweight", "feature_complex"] as const) {
		const harness = createFeaturePromptHarness({ classifyRequest: async () => classifierDecision(kind) });
		const result = await harness.runInRpcMode("Add a capability in T3 Code");
		assert.ok(result);
		assert.match(result.systemPrompt, /Inside T3 Code, an available `delegate_task` capability/);
		assert.match(result.systemPrompt, /including harness-prefixed tool names/);
		assert.match(result.systemPrompt, /satisfies the skill's Pi `subagent` requirement/);
		assert.match(result.systemPrompt, /do not request a waiver or extra implementation approval solely because Pi's native `subagent` tool is absent/);
		assert.match(result.systemPrompt, /If required delegation is unavailable, stop at the affected gate/);
		assert.match(result.systemPrompt, /do not lower worker or independent-review requirements/);
	}
});

test("feature skill availability checks prompt discovery and required files", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-feature-skill-check-"));
	try {
		const skillDir = join(agentDir, "skills", FEATURE_SKILL_NAME);
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Feature workflow\n", "utf8");
		const skillPath = join(skillDir, "SKILL.md");
		const systemPrompt = `<available_skills><skill><name>${FEATURE_SKILL_NAME}</name><location>${skillPath}</location></skill></available_skills>`;
		assert.equal(featureSkillIsAvailable(systemPrompt, "lightweight"), true);
		assert.equal(featureSkillIsAvailable(systemPrompt, "complex"), false);
		writeFileSync(join(skillDir, "references", "COMPLEX-FEATURE-CONTRACT.md"), "# Contract\n", "utf8");
		assert.equal(featureSkillIsAvailable(systemPrompt, "complex"), true);
		assert.equal(featureSkillIsAvailable("<available_skills></available_skills>", "lightweight"), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("session starts reset continuation state for startup, new, resume, fork, and reload", async () => {
	for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
		const classifications: ClassifierDecision[] = [
			classifierDecision("feature_complex"),
			classifierDecision("continuation"),
		];
		const harness = createFeaturePromptHarness({
			classifyRequest: async () => classifications.shift(),
		});
		assert.deepEqual(await harness.run("Add a command palette"), { systemPrompt: injectedFeaturePrompt("feature_complex") }, reason);
		harness.runLifecycle("session_start");
		assert.equal(await harness.run("Continue"), undefined, reason);
	}
});

test("tree navigation resets branch-local continuation state", async () => {
	const classifications: ClassifierDecision[] = [
		classifierDecision("feature_lightweight"),
		classifierDecision("continuation"),
	];
	const harness = createFeaturePromptHarness({
		classifyRequest: async () => classifications.shift(),
	});
	assert.deepEqual(await harness.run("Add a command palette"), { systemPrompt: injectedFeaturePrompt("feature_lightweight") });
	harness.runLifecycle("session_tree");
	assert.equal(await harness.run("Continue"), undefined);
});

test("extension registration is inert until a lifecycle event and has no hard-coded classifier model contract", () => {
	const registeredEvents: string[] = [];
	featureSystemPrompt({
		on(name: string) {
			registeredEvents.push(name);
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(registeredEvents, ["session_start", "session_tree", "before_agent_start"]);
	assert.equal(CLASSIFIER_TIMEOUT_MS, 15_000);
});
