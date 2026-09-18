import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface GrillTurn {
	question: string;
	recommendedAnswer: string;
	userAnswer?: string;
	decisionStatus: "resolved" | "open" | "needs-codebase-check";
	notes?: string;
}

interface GrillState {
	createdAt: string;
	updatedAt: string;
	projectDir: string;
	plan: string;
	turns: GrillTurn[];
}

const RecordTurnParams = Type.Object({
	question: Type.String({ description: "The exact question asked, one question only." }),
	recommendedAnswer: Type.String({ description: "The assistant's recommended answer to the question." }),
	userAnswer: Type.Optional(Type.String({ description: "The user's explicit answer. Required when decisionStatus is resolved." })),
	decisionStatus: Type.Union([
		Type.Literal("resolved"),
		Type.Literal("open"),
		Type.Literal("needs-codebase-check"),
	]),
	notes: Type.Optional(Type.String({ description: "Short rationale, dependency, or follow-up notes." })),
});

const SaveResultsParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Relative output path. Defaults to GRILL-ME.md." })),
	summary: Type.Optional(Type.String({ description: "Optional current shared-understanding summary." })),
	agreedDecisions: Type.Optional(Type.Array(Type.String())),
	openRisks: Type.Optional(Type.Array(Type.String())),
	nextDecisionNeeded: Type.Optional(Type.String()),
});

function stateDir(cwd: string): string {
	return join(cwd, ".pi", "grill-me");
}

function statePath(cwd: string): string {
	return join(stateDir(cwd), "state.json");
}

async function readState(cwd: string): Promise<GrillState | undefined> {
	try {
		return JSON.parse(await readFile(statePath(cwd), "utf8")) as GrillState;
	} catch {
		return undefined;
	}
}

async function writeState(cwd: string, state: GrillState): Promise<void> {
	await mkdir(stateDir(cwd), { recursive: true });
	await writeFile(statePath(cwd), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function renderMarkdown(
	state: GrillState,
	extra: { summary?: string; agreedDecisions?: string[]; openRisks?: string[]; nextDecisionNeeded?: string },
): string {
	const lines: string[] = [];
	lines.push("# Grill Me Results", "");
	lines.push(`Generated: ${new Date().toISOString()}`, "");
	lines.push("## Plan", "", state.plan.trim() || "_(none recorded)_", "");
	if (extra.summary?.trim()) {
		lines.push("## Shared Understanding", "", extra.summary.trim(), "");
	}
	lines.push("## Questions and Answers", "");
	if (state.turns.length === 0) {
		lines.push("_(No turns recorded.)", "");
	} else {
		state.turns.forEach((turn, index) => {
			lines.push(`### ${index + 1}. ${turn.question}`, "");
			lines.push(`**Recommended answer:** ${turn.recommendedAnswer || "_(none)_"}`, "");
			lines.push(`**User answer:** ${turn.userAnswer || "_(not recorded)_"}`, "");
			lines.push(`**Status:** ${turn.decisionStatus}`, "");
			if (turn.notes?.trim()) lines.push(`**Notes:** ${turn.notes.trim()}`, "");
		});
	}
	if (extra.agreedDecisions?.length) {
		lines.push("## Agreed Decisions", "", ...extra.agreedDecisions.map((d) => `- ${d}`), "");
	}
	if (extra.openRisks?.length) {
		lines.push("## Open Risks", "", ...extra.openRisks.map((r) => `- ${r}`), "");
	}
	if (extra.nextDecisionNeeded?.trim()) {
		lines.push("## Next Decision Needed", "", extra.nextDecisionNeeded.trim(), "");
	}
	return lines.join("\n");
}

function safeOutputPath(cwd: string, input?: string): string {
	const requested = input?.trim() || "GRILL-ME.md";
	const absolute = resolve(cwd, requested);
	const root = resolve(cwd);
	if (absolute !== root && !absolute.startsWith(root + "/")) {
		throw new Error(`Refusing to write outside project directory: ${requested}`);
	}
	return absolute;
}

const MISSING_PLAN = "(No plan supplied; collect it through questionnaire intake.)";

function interviewPrompt(plan: string, needsPlanIntake: boolean): string {
	const intake = needsPlanIntake
		? `\nPlan intake:\n- The user did not supply a plan. Your first user-facing question must be a questionnaire start call with one single-select question. If this conversation or project contains a concrete plan, offer an option whose label names that plan, such as \"Use existing plan: <short description>\". Otherwise offer a choice to stop without starting. Keep allowOther true so the user can describe a plan. Do not ask for the plan in ordinary chat and do not invent one.\n- After intake completes, record the resolved plan-intake answer first with grill_record_turn and an explicit userAnswer, before recording any other turn. Until that answer is recorded, do not record codebase discoveries, open questions, or other decisions. Then use the selected or custom plan as the interview subject. If the user chose to stop, save partial results and end the interview.`
		: "";

	return `Run /grill-me for this plan:\n\n${plan}\n\nThis is a model-guided interview. During /grill-me, this protocol replaces generic questionnaire advice to ask in chat after cancellation or unavailability. Follow this protocol exactly:${intake}\n\nQuestion rounds:\n- Investigate codebase-answerable facts before asking the user. Record a discovered decision when useful, but do not ask the user to repeat facts the code establishes.\n- Gather every currently answerable, independent user decision into one questionnaire start call, up to 20 questions. Hold dependent questions for a later round. Every initial or follow-up user decision must use questionnaire, even when only one question remains. Never fall back to ordinary chat questions.\n- Give every questionnaire question stable IDs, usable choices, allowOther true, and a recommendation with a short reason in the question prompt. Do not request passwords, tokens, or other secrets.\n- Treat each questionnaire result by its status. If it needs clarification, answer the clarification request in normal text and immediately call questionnaire resume with the exact questionnaireId and revision from that result. Do not restart the questionnaire or infer the pending answer.\n- For completed, cancelled, or unavailable results, call grill_record_turn once for each newly returned explicit answer, in questionnaire order. Convert selected option IDs to their visible labels and include every selected label plus any custom Other value in userAnswer. Keep one question per call and include the recommendation that was shown. Do not record the same answer twice after a resume.\n- A completed questionnaire finishes only that round. Evaluate the answers for conflicts, changed assumptions, and remaining ambiguity before starting another round. Do not repeat resolved questions unless answers conflict or change.\n- If questionnaire returns cancelled or unavailable, do not reopen it and do not ask in chat. Save the answered decisions as partial results with remaining ambiguities in openRisks and nextDecisionNeeded, then stop. For unavailable, explain that Grill Me needs an interactive TUI or RPC questionnaire and can resume after that capability is restored.\n- When all identified ambiguities are resolved, call grill_save_results with the final shared understanding, agreed decisions, and any open risks. If the user asks to stop or save before then, save partial results and state what remains unresolved. Never claim full resolution after cancellation, unavailability, or a postponed decision.`;
}

export default function grillMeExtension(pi: ExtensionAPI) {
	let registeredBundledQuestionnaire = false;
	pi.on?.("session_start", async () => {
		if (registeredBundledQuestionnaire || pi.getAllTools().some((tool) => tool.name === "questionnaire")) return;
		const { default: questionnaireExtension } = await import("@firstpick/pi-package-questionnaire/index.ts");
		if (pi.getAllTools().some((tool) => tool.name === "questionnaire")) return;
		questionnaireExtension(pi);
		registeredBundledQuestionnaire = true;
	});

	pi.registerCommand("grill-me", {
		description: "Start a questionnaire-based design interview and save results to Markdown",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				ctx.ui.notify("Grill Me requires questionnaire UI in TUI or RPC mode. No grill session was started.", "error");
				return;
			}
			if (!pi.getAllTools().some((tool) => tool.name === "questionnaire")) {
				ctx.ui.notify("Grill Me could not find the questionnaire tool. Reinstall the package or enable its bundled questionnaire extension, reload Pi, and try again.", "error");
				return;
			}
			if (!pi.getActiveTools().includes("questionnaire")) {
				ctx.ui.notify("Grill Me needs the questionnaire tool, but it is disabled. Enable it, reload Pi, and try again.", "error");
				return;
			}

			const suppliedPlan = args.trim();
			const plan = suppliedPlan || MISSING_PLAN;
			const state: GrillState = {
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				projectDir: ctx.cwd,
				plan,
				turns: [],
			};
			await writeState(ctx.cwd, state);
			ctx.ui.notify(`Grill session initialized: ${statePath(ctx.cwd)}`, "info");

			pi.sendUserMessage(interviewPrompt(plan, suppliedPlan.length === 0));
		},
	});

	pi.registerTool({
		name: "grill_record_turn",
		label: "Grill Record Turn",
		description: "Record one /grill-me question, recommended answer, user answer, and decision status in project state.",
		promptSnippet: "Record structured progress for an active /grill-me design interview",
		promptGuidelines: [
			"Use grill_record_turn after each /grill-me interview question is answered or resolved from codebase exploration.",
			"For a resolved turn, userAnswer must contain the explicit selected or discovered answer; notes are not a substitute.",
			"Do not use grill_record_turn for more than one question at a time.",
		],
		parameters: RecordTurnParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.decisionStatus === "resolved" && !params.userAnswer?.trim()) {
				return {
					content: [{
						type: "text",
						text: "userAnswer is required for resolved turns. Retry with the user's explicit choice or the answer discovered from the codebase.",
					}],
					isError: true,
					details: { path: statePath(ctx.cwd), decisionStatus: params.decisionStatus },
				};
			}
			const state = (await readState(ctx.cwd)) ?? {
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				projectDir: ctx.cwd,
				plan: "(state was created by grill_record_turn; no plan recorded)",
				turns: [],
			};
			const userAnswer = params.userAnswer?.trim() || undefined;
			if (state.plan === MISSING_PLAN && state.turns.length === 0 && params.decisionStatus === "resolved" && userAnswer) {
				state.plan = userAnswer;
			}
			state.turns.push({
				...params,
				userAnswer,
			} as GrillTurn);
			state.updatedAt = new Date().toISOString();
			await writeState(ctx.cwd, state);
			return {
				content: [{ type: "text", text: `Recorded grill turn #${state.turns.length}` }],
				details: { path: statePath(ctx.cwd), count: state.turns.length },
			};
		},
	});

	pi.registerTool({
		name: "grill_save_results",
		label: "Grill Save Results",
		description: "Save the active /grill-me interview state as a Markdown file inside the project directory.",
		promptSnippet: "Save /grill-me interview decisions and risks to Markdown in the project directory",
		promptGuidelines: ["Use grill_save_results when the /grill-me interview is complete or the user asks to save/stop."],
		parameters: SaveResultsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await readState(ctx.cwd);
			if (!state) {
				return {
					content: [{ type: "text", text: "No active /grill-me state found. Run /grill-me first." }],
					isError: true,
					details: { path: statePath(ctx.cwd) },
				};
			}
			const outputPath = safeOutputPath(ctx.cwd, params.path);
			await writeFile(outputPath, renderMarkdown(state, params), "utf8");
			return {
				content: [{ type: "text", text: `Saved grill results to ${outputPath}` }],
				details: { path: outputPath, turns: state.turns.length },
			};
		},
	});
}
