import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SubagentExecutionMode = "direct" | "tasks" | "chain" | "indeterminate";
export type SubagentAnalysisKind = SubagentExecutionMode | "scheduled" | "non-execution";

export interface SubagentFanoutAnalysis {
	kind: SubagentAnalysisKind;
	mode?: SubagentExecutionMode;
	guaranteedChildren: number;
	guaranteedWorkers: number;
	execution: boolean;
	workerExecution: boolean;
	dynamicFanout: boolean;
	scheduledKind?: SubagentExecutionMode;
}

export type ReviewerDiversityFailure =
	| "dynamic-reviewer-fanout"
	| "implicit-reviewer-model"
	| "duplicate-reviewer-provider"
	| "duplicate-reviewer-model";

export interface ReviewerDiversityAnalysis {
	reviewerLaunches: number;
	dynamicReviewerFanout: boolean;
	providers: string[];
	models: string[];
	failure?: ReviewerDiversityFailure;
	violation: boolean;
}

export const REVIEWER_DIVERSITY_GUIDANCE = [
	"Reviewer provider selection: use different provider families when suitable models are available, authorized, and unblocked.",
	"Check live availability and known authentication, quota, rate-limit, outage, model-scope, and policy restrictions; a catalog entry alone does not prove usability.",
	"If no usable different-provider alternative exists or an attempted alternative fails, continue with the same provider, including the same model in separate fresh-context reviewer runs if needed.",
	"Record the fallback reason and evidence; provider or model reuse needs no waiver. Do not retry known-blocked alternatives merely for diversity, bypass restrictions, or duplicate live reviewer runs.",
	"Preserve the independent read-only reviewer-run quorum required by the active feature or project policy; two reviews require two separate runs and outputs.",
	"With subagent_gate, keep the required success count and use requireDistinctProviders: false to allow fallback; do not exclude a provider solely for diversity.",
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns a declared positive integer count, defaulting invalid or omitted values to one child. */
export function positiveTaskCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function isWorkerTask(task: unknown): task is Record<string, unknown> & { agent: "worker" } {
	return isRecord(task) && task.agent === "worker";
}

function isReviewerTask(task: unknown): task is Record<string, unknown> & { agent: string } {
	return isRecord(task)
		&& typeof task.agent === "string"
		&& (task.agent === "reviewer" || task.agent.endsWith(".reviewer"));
}

interface ReviewerRoute {
	provider: string;
	model: string;
}

const THINKING_SUFFIX_PATTERN = /:(?:off|minimal|low|medium|high|xhigh|max)$/i;

/** Returns a comparable explicit provider/model route, excluding thinking effort. */
export function normalizeReviewerRoute(model: unknown): ReviewerRoute | undefined {
	if (typeof model !== "string") return undefined;
	const normalized = model.trim().replace(THINKING_SUFFIX_PATTERN, "").toLowerCase();
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) return undefined;
	return {
		provider: normalized.slice(0, separator),
		model: normalized,
	};
}

/** Sums the statically declared children in a top-level tasks workflow. */
export function countStaticTasks(tasks: unknown): number {
	if (!Array.isArray(tasks)) return 0;
	return tasks.reduce((total, task) => total + positiveTaskCount(isRecord(task) ? task.count : undefined), 0);
}

/** Sums statically declared launches of the implementation worker agent. */
export function countStaticWorkers(tasks: unknown): number {
	if (!Array.isArray(tasks)) return 0;
	return tasks.reduce((total, task) => total + (isWorkerTask(task)
		? positiveTaskCount(task.count)
		: 0), 0);
}

export interface StaticChainCount {
	guaranteedChildren: number;
	guaranteedWorkers: number;
	workerExecution: boolean;
	dynamicFanout: boolean;
}

/**
 * Counts only chain children that are known at tool-call time. Dynamic expand
 * templates intentionally contribute zero because their cardinality is unknown.
 */
export function countStaticChainChildren(chain: unknown): StaticChainCount {
	if (!Array.isArray(chain)) {
		return { guaranteedChildren: 0, guaranteedWorkers: 0, workerExecution: false, dynamicFanout: false };
	}

	return chain.reduce<StaticChainCount>((total, step) => {
		if (!isRecord(step)) return total;

		if (Array.isArray(step.parallel)) {
			return {
				guaranteedChildren: total.guaranteedChildren + countStaticTasks(step.parallel),
				guaranteedWorkers: total.guaranteedWorkers + countStaticWorkers(step.parallel),
				workerExecution: total.workerExecution || step.parallel.some(isWorkerTask),
				dynamicFanout: total.dynamicFanout,
			};
		}

		if (isRecord(step.parallel) || step.expand !== undefined) {
			return {
				...total,
				workerExecution: total.workerExecution || isWorkerTask(step.parallel),
				dynamicFanout: true,
			};
		}

		if (typeof step.agent === "string") {
			const worker = step.agent === "worker";
			return {
				...total,
				guaranteedChildren: total.guaranteedChildren + 1,
				guaranteedWorkers: total.guaranteedWorkers + (worker ? 1 : 0),
				workerExecution: total.workerExecution || worker,
			};
		}

		return total;
	}, { guaranteedChildren: 0, guaranteedWorkers: 0, workerExecution: false, dynamicFanout: false });
}

function analyzeExecution(input: Record<string, unknown>): SubagentFanoutAnalysis {
	if (Array.isArray(input.chain) && input.chain.length > 0) {
		const chain = countStaticChainChildren(input.chain);
		const mode: SubagentExecutionMode = chain.dynamicFanout && chain.guaranteedChildren === 0 ? "indeterminate" : "chain";
		return {
			kind: mode,
			mode,
			guaranteedChildren: chain.guaranteedChildren,
			guaranteedWorkers: chain.guaranteedWorkers,
			execution: true,
			workerExecution: chain.workerExecution,
			dynamicFanout: chain.dynamicFanout,
		};
	}

	if (Array.isArray(input.tasks) && input.tasks.length > 0) {
		return {
			kind: "tasks",
			mode: "tasks",
			guaranteedChildren: countStaticTasks(input.tasks),
			guaranteedWorkers: countStaticWorkers(input.tasks),
			execution: true,
			workerExecution: input.tasks.some(isWorkerTask),
			dynamicFanout: false,
		};
	}

	if (typeof input.agent === "string") {
		const worker = input.agent === "worker";
		return {
			kind: "direct",
			mode: "direct",
			guaranteedChildren: 1,
			guaranteedWorkers: worker ? 1 : 0,
			execution: true,
			workerExecution: worker,
			dynamicFanout: false,
		};
	}

	return {
		kind: "indeterminate",
		mode: "indeterminate",
		guaranteedChildren: 0,
		guaranteedWorkers: 0,
		execution: true,
		workerExecution: false,
		dynamicFanout: false,
	};
}

/**
 * Analyzes one model-initiated subagent call. Only action="schedule" is a new
 * deferred execution; all other actions are management or control operations.
 */
export function analyzeSubagentCall(input: unknown): SubagentFanoutAnalysis {
	if (!isRecord(input)) {
		return {
			kind: "indeterminate",
			mode: "indeterminate",
			guaranteedChildren: 0,
			guaranteedWorkers: 0,
			execution: true,
			workerExecution: false,
			dynamicFanout: false,
		};
	}

	if (typeof input.action === "string") {
		const actionAlias = input.action.toLowerCase();
		const aliasesSingleExecution = actionAlias === "single" && (input.agent !== undefined || input.task !== undefined);
		const aliasesTaskExecution = (actionAlias === "parallel" || actionAlias === "tasks")
			&& Array.isArray(input.tasks)
			&& input.tasks.length > 0;
		if (aliasesSingleExecution || aliasesTaskExecution) return analyzeExecution(input);

		if (input.action !== "schedule") {
			return {
				kind: "non-execution",
				guaranteedChildren: 0,
				guaranteedWorkers: 0,
				execution: false,
				workerExecution: false,
				dynamicFanout: false,
			};
		}

		const scheduled = analyzeExecution(input);
		return {
			kind: "scheduled",
			mode: scheduled.mode,
			guaranteedChildren: scheduled.guaranteedChildren,
			guaranteedWorkers: scheduled.guaranteedWorkers,
			execution: true,
			workerExecution: scheduled.workerExecution,
			dynamicFanout: scheduled.dynamicFanout,
			scheduledKind: scheduled.kind as SubagentExecutionMode,
		};
	}

	return analyzeExecution(input);
}

interface CollectedReviewerRoutes {
	routes: Array<ReviewerRoute | undefined>;
	dynamicReviewerFanout: boolean;
}

function collectTaskReviewerRoutes(tasks: unknown): Array<ReviewerRoute | undefined> {
	if (!Array.isArray(tasks)) return [];
	return tasks.flatMap((task) => {
		if (!isReviewerTask(task)) return [];
		return Array.from({ length: positiveTaskCount(task.count) }, () => normalizeReviewerRoute(task.model));
	});
}

function collectReviewerRoutes(input: Record<string, unknown>, mode: SubagentExecutionMode | undefined): CollectedReviewerRoutes {
	if (mode === "tasks") {
		return { routes: collectTaskReviewerRoutes(input.tasks), dynamicReviewerFanout: false };
	}

	if (mode === "chain" || mode === "indeterminate") {
		const collected: CollectedReviewerRoutes = { routes: [], dynamicReviewerFanout: false };
		if (!Array.isArray(input.chain)) return collected;
		for (const step of input.chain) {
			if (!isRecord(step)) continue;
			if (Array.isArray(step.parallel)) {
				collected.routes.push(...collectTaskReviewerRoutes(step.parallel));
				continue;
			}
			if (isRecord(step.parallel) || step.expand !== undefined) {
				if (isReviewerTask(step.parallel) || isReviewerTask(step)) collected.dynamicReviewerFanout = true;
				continue;
			}
			if (isReviewerTask(step)) collected.routes.push(normalizeReviewerRoute(step.model));
		}
		return collected;
	}

	return {
		routes: isReviewerTask(input) ? [normalizeReviewerRoute(input.model)] : [],
		dynamicReviewerFanout: false,
	};
}

/** Reports static route diversity only; a violation is diagnostic, not a launch blocker or availability check. */
export function analyzeReviewerDiversity(input: unknown): ReviewerDiversityAnalysis {
	const execution = analyzeSubagentCall(input);
	if (!execution.execution || !isRecord(input)) {
		return {
			reviewerLaunches: 0,
			dynamicReviewerFanout: false,
			providers: [],
			models: [],
			violation: false,
		};
	}

	const collected = collectReviewerRoutes(input, execution.mode);
	const explicitRoutes = collected.routes.filter((route): route is ReviewerRoute => route !== undefined);
	const providers = explicitRoutes.map((route) => route.provider);
	const models = explicitRoutes.map((route) => route.model);
	let failure: ReviewerDiversityFailure | undefined;

	if (collected.dynamicReviewerFanout) failure = "dynamic-reviewer-fanout";
	else if (collected.routes.length >= 2 && explicitRoutes.length !== collected.routes.length) failure = "implicit-reviewer-model";
	else if (collected.routes.length >= 2 && new Set(models).size !== models.length) failure = "duplicate-reviewer-model";
	else if (collected.routes.length >= 2 && new Set(providers).size !== providers.length) failure = "duplicate-reviewer-provider";

	return {
		reviewerLaunches: collected.routes.length,
		dynamicReviewerFanout: collected.dynamicReviewerFanout,
		providers,
		models,
		failure,
		violation: failure !== undefined,
	};
}

export default function subagentMinimumFanout(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const tools = pi.getActiveTools();
		if (!tools.includes("subagent") && !tools.includes("subagent_gate")) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${REVIEWER_DIVERSITY_GUIDANCE}` };
	});
}
