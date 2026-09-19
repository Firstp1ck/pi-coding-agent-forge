import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import subagentMinimumFanout, {
	analyzeReviewerDiversity,
	analyzeSubagentCall,
	countStaticChainChildren,
	countStaticTasks,
	countStaticWorkers,
	normalizeReviewerRoute,
	positiveTaskCount,
	REVIEWER_DIVERSITY_GUIDANCE,
} from "../subagent-minimum-fanout.ts";

type ToolCallHandler = (event: ToolCallEvent) => ToolCallEventResult | undefined;

type BeforeAgentStartHandler = (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;

function createHarness(activeTools = ["subagent"]) {
	let handler: ToolCallHandler | undefined;
	let beforeStart: BeforeAgentStartHandler | undefined;
	subagentMinimumFanout({
		getActiveTools: () => activeTools,
		on(name: string, candidate: unknown) {
			if (name === "tool_call") handler = candidate as ToolCallHandler;
			if (name === "before_agent_start") beforeStart = candidate as BeforeAgentStartHandler;
		},
	} as unknown as ExtensionAPI);
	if (!beforeStart) throw new Error("before_agent_start handler was not registered");

	return {
		call(toolName: string, input: unknown) {
			return handler?.({ type: "tool_call", toolCallId: "test", toolName, input } as ToolCallEvent);
		},
		start(systemPrompt = "Existing instructions") {
			return beforeStart({ systemPrompt });
		},
	};
}

function assertAllowed(input: Record<string, unknown>) {
	assert.equal(createHarness().call("subagent", input), undefined);
}

test("review guidance is conditional on active delegation tools and preserves existing instructions", () => {
	for (const tools of [["subagent"], ["subagent_gate"], ["read", "subagent", "subagent_gate"]]) {
		assert.deepEqual(createHarness(tools).start(), {
			systemPrompt: `Existing instructions\n\n${REVIEWER_DIVERSITY_GUIDANCE}`,
		});
	}
	assert.equal(createHarness([]).start(), undefined);
	assert.equal(createHarness(["read", "bash"]).start(), undefined);
});

test("guidance preserves conditional diversity, same-model fallback, and independent review quorum", () => {
	for (const phrase of [
		"different provider families when suitable models are available, authorized, and unblocked",
		"a catalog entry alone does not prove usability",
		"an attempted alternative fails, continue with the same provider",
		"including the same model in separate fresh-context reviewer runs",
		"Record the fallback reason and evidence",
		"provider or model reuse needs no waiver",
		"Do not retry known-blocked alternatives",
		"bypass restrictions, or duplicate live reviewer runs",
		"two reviews require two separate runs and outputs",
		"requireDistinctProviders: false",
	]) assert.ok(REVIEWER_DIVERSITY_GUIDANCE.includes(phrase), phrase);
});

test("positive task count defaults invalid values to one and sums top-level tasks", () => {
	assert.equal(positiveTaskCount(2), 2);
	for (const value of [undefined, 0, -1, 1.5, Number.POSITIVE_INFINITY, "2"]) {
		assert.equal(positiveTaskCount(value), 1, String(value));
	}
	const tasks = [{ agent: "worker", count: 2 }, { agent: "reviewer" }];
	assert.equal(countStaticTasks(tasks), 3);
	assert.equal(countStaticWorkers(tasks), 2);
});

test("direct single-worker execution is analyzed and allowed", () => {
	const input = { agent: "worker", task: "Implement the change" };
	assert.deepEqual(analyzeSubagentCall(input), {
		kind: "direct",
		mode: "direct",
		guaranteedChildren: 1,
		guaranteedWorkers: 1,
		execution: true,
		workerExecution: true,
		dynamicFanout: false,
	});
	assertAllowed(input);
});

test("single tasks, legacy chain steps, and workflow scripts are allowed", () => {
	const oneTask = { tasks: [{ agent: "worker", task: "Implement the change" }] };
	const oneStep = { chain: [{ agent: "worker", task: "Implement the change" }] };
	const workflowScript = { workflowScript: "return await runs.run('implementation', { agent: 'worker', task: 'Implement the change' });" };

	assert.equal(analyzeSubagentCall(oneTask).guaranteedChildren, 1);
	assert.equal(analyzeSubagentCall(oneStep).guaranteedChildren, 1);
	assertAllowed(oneTask);
	assertAllowed(oneStep);
	assertAllowed(workflowScript);
});

test("two declared children and two declared workers are allowed", () => {
	assertAllowed({
		tasks: [
			{ agent: "reviewer", task: "Review correctness", model: "anthropic/claude-opus-5:high" },
			{ agent: "reviewer", task: "Review tests", model: "openai-codex/gpt-5.6-sol:high" },
		],
	});
	assertAllowed({ tasks: [{ agent: "worker", task: "Implement the change", count: 2 }] });
	assertAllowed({
		chain: [
			{ agent: "worker", task: "Implement slice A" },
			{ agent: "worker", task: "Implement slice B" },
		],
	});
	assertAllowed({ chain: [{ parallel: [{ agent: "worker", task: "Implement the change", count: 2 }] }] });

	assert.deepEqual(countStaticChainChildren([
		{ agent: "worker", task: "Implement the change" },
		{ parallel: [{ agent: "reviewer", task: "Review the change", count: 2 }] },
	]), {
		guaranteedChildren: 3,
		guaranteedWorkers: 1,
		workerExecution: true,
		dynamicFanout: false,
	});
});

test("mixed-role executions do not impose a worker minimum", () => {
	for (const input of [
		{
			tasks: [
				{ agent: "worker", task: "Implement" },
				{ agent: "reviewer", task: "Review" },
			],
		},
		{
			chain: [
				{ agent: "worker", task: "Implement" },
				{ agent: "reviewer", task: "Review" },
			],
		},
		{
			action: "schedule",
			chain: [
				{ agent: "worker", task: "Implement" },
				{ agent: "reviewer", task: "Review" },
			],
			schedule: "+10m",
		},
	]) {
		const analysis = analyzeSubagentCall(input);
		assert.equal(analysis.guaranteedWorkers, 1);
		assert.equal(analysis.workerExecution, true);
		assertAllowed(input);
	}
});

test("dynamic worker fanout is not blocked by a cardinality minimum", () => {
	const dynamicStep = {
		expand: { from: { output: "targets", path: "/items" } },
		parallel: { agent: "worker", task: "Inspect {item}" },
		collect: { as: "results" },
	};
	const input = { chain: [dynamicStep] };
	const analysis = analyzeSubagentCall(input);
	assert.equal(analysis.kind, "indeterminate");
	assert.equal(analysis.guaranteedChildren, 0);
	assert.equal(analysis.dynamicFanout, true);
	assert.equal(analysis.workerExecution, true);
	assertAllowed(input);
});

test("execution-mode action aliases allow single workers case-insensitively", () => {
	for (const action of ["single", "SINGLE", "Single"]) {
		assertAllowed({ action, agent: "worker", task: "Implement" });
	}
	for (const action of ["tasks", "TASKS", "parallel", "Parallel"]) {
		assertAllowed({ action, tasks: [{ agent: "worker", task: "Implement" }] });
	}
});

test("scheduled direct workers are allowed", () => {
	const input = { action: "schedule", agent: "worker", task: "Implement", schedule: "+10m" };
	const analysis = analyzeSubagentCall(input);
	assert.equal(analysis.kind, "scheduled");
	assert.equal(analysis.scheduledKind, "direct");
	assert.equal(analysis.guaranteedChildren, 1);
	assertAllowed(input);
});

test("management, status, control, recovery, and non-schedule actions remain exempt", () => {
	for (const action of ["list", "status", "resume", "steer", "interrupt", "stop", "append-step", "watchdog.status", "watchdog.configure", "schedule-list", "schedule-status", "schedule-cancel", "unknown-action"]) {
		const analysis = analyzeSubagentCall({ action, agent: "worker" });
		assert.deepEqual(analysis, {
			kind: "non-execution",
			guaranteedChildren: 0,
			guaranteedWorkers: 0,
			execution: false,
			workerExecution: false,
			dynamicFanout: false,
		}, action);
		assertAllowed({ action, agent: "worker" });
	}
});

test("reviewer routes normalize thinking suffixes and provider casing", () => {
	assert.deepEqual(normalizeReviewerRoute(" OpenRouter/MoonshotAI/Kimi-K3:HIGH "), {
		provider: "openrouter",
		model: "openrouter/moonshotai/kimi-k3",
	});
	assert.equal(normalizeReviewerRoute("kimi-k3:high"), undefined);
	assert.equal(normalizeReviewerRoute(undefined), undefined);
});

test("same-provider, same-model, and implicit routes are diagnostic only and never block fallback", () => {
	const duplicateModel = {
		tasks: [
			{ agent: "reviewer", task: "Review correctness", model: "openrouter/moonshotai/kimi-k3:high" },
			{ agent: "reviewer", task: "Review tests", model: "OPENROUTER/MOONSHOTAI/KIMI-K3:medium" },
		],
	};
	assert.equal(analyzeReviewerDiversity(duplicateModel).failure, "duplicate-reviewer-model");
	assertAllowed(duplicateModel);

	const duplicateProvider = {
		tasks: [
			{ agent: "reviewer", task: "Review correctness", model: "anthropic/claude-opus-5:high" },
			{ agent: "reviewer", task: "Review tests", model: "anthropic/claude-fable-5:high" },
		],
	};
	assert.equal(analyzeReviewerDiversity(duplicateProvider).failure, "duplicate-reviewer-provider");
	assertAllowed(duplicateProvider);

	for (const input of [
		{
			tasks: [
				{ agent: "reviewer", task: "Review correctness" },
				{ agent: "reviewer", task: "Review tests", model: "openai-codex/gpt-5.6-sol:high" },
			],
		},
		{
			tasks: [
				{ agent: "reviewer", task: "Review correctness", model: "claude-opus-5:high" },
				{ agent: "reviewer", task: "Review tests", model: "openai-codex/gpt-5.6-sol:high" },
			],
		},
		{ tasks: [{ agent: "reviewer", task: "Review twice", model: "anthropic/claude-opus-5", count: 2 }] },
	]) {
		assert.equal(analyzeReviewerDiversity(input).violation, true);
		assertAllowed(input);
	}

	assertAllowed({
		tasks: [
			{ agent: "reviewer", task: "Review correctness", model: "anthropic/claude-opus-5:high" },
			{ agent: "reviewer", task: "Review tests", model: "openrouter/moonshotai/kimi-k3:high" },
			{ agent: "scout", task: "Inspect test coverage" },
		],
	});
	assertAllowed({
		tasks: [
			{ agent: "reviewer", task: "Review correctness" },
			{ agent: "scout", task: "Inspect test coverage" },
		],
	});
});

test("static chains, schedules, aliases, qualified names, and dynamic reviewers allow fallback", () => {
	for (const input of [
		{
			chain: [
				{ agent: "reviewer", task: "Review correctness", model: "openrouter/moonshotai/kimi-k3" },
				{ agent: "reviewer", task: "Review tests", model: "openrouter/moonshotai/kimi-k3:high" },
			],
		},
		{
			chain: [{ parallel: [
				{ agent: "reviewer", task: "Review correctness", model: "anthropic/claude-opus-5" },
				{ agent: "reviewer", task: "Review tests", model: "anthropic/claude-fable-5" },
			] }],
		},
		{
			action: "schedule",
			tasks: [
				{ agent: "reviewer", task: "Review correctness", model: "openai-codex/gpt-5.6-sol" },
				{ agent: "reviewer", task: "Review tests", model: "openai-codex/gpt-5.6-terra" },
			],
			schedule: "+10m",
		},
		{
			action: "parallel",
			tasks: [
				{ agent: "code-analysis.reviewer", task: "Review correctness", model: "anthropic/claude-opus-5" },
				{ agent: "reviewer", task: "Review tests", model: "anthropic/claude-fable-5" },
			],
		},
	]) {
		assertAllowed(input);
	}

	const dynamic = {
		chain: [
			{ agent: "planner", task: "Identify review targets" },
			{ agent: "scout", task: "Inspect coverage" },
			{
				expand: { from: { output: "targets", path: "/items" } },
				parallel: { agent: "reviewer", task: "Review {item}", model: "anthropic/claude-opus-5" },
			},
		],
	};
	assert.equal(analyzeReviewerDiversity(dynamic).failure, "dynamic-reviewer-fanout");
	assertAllowed(dynamic);
});

test("management calls remain exempt from reviewer diversity", () => {
	assertAllowed({ action: "get", agent: "reviewer", model: "anthropic/claude-opus-5" });
	assert.equal(analyzeReviewerDiversity({ action: "get", agent: "reviewer" }).violation, false);
});

test("independent single-child calls, malformed input, and non-subagent tools pass through", () => {
	const harness = createHarness();
	const input = { agent: "worker", task: "Implement" };
	assert.equal(harness.call("subagent", input), undefined);
	assert.equal(harness.call("subagent", input), undefined);
	assert.equal(harness.call("subagent", null), undefined);
	assert.equal(harness.call("subagent", {}), undefined);
	assert.equal(harness.call("read", { path: "README.md" }), undefined);
});
