import type { EvaluationConfig } from "./types.ts";

export type EvaluationSuite = "retrieval" | "agentic" | "coding" | "all";
export type LiveEvaluationRequest = { suite: EvaluationSuite; model?: string };

/** The only packet shape an adapter may receive. Ground truth remains host-only. */
export type SanitizedEvaluationCase = {
  id: string;
  suite: Exclude<EvaluationSuite, "all">;
  prompt: string;
  source_context?: string;
};

export type ObservedOutcome = "supported" | "insufficient" | "blocked" | "failed" | "schema-invalid";
export type HostEvaluationCase = SanitizedEvaluationCase & {
  evaluateOutput(output: string): ObservedOutcome;
  expected_outcome: ObservedOutcome;
};

export type LiveEvaluationAdapter = {
  model: string;
  kind?: "native" | "simulated";
  invoke(packet: Readonly<{ model: string; cases: readonly SanitizedEvaluationCase[]; maxOutputChars: number; maxOutputTokens: number }>, signal: AbortSignal): Promise<ReadonlyArray<{ id: string; output: string }> | { results: ReadonlyArray<{ id: string; output: string }>; aggregate_usage?: { input_tokens: number; output_tokens: number } }>;
};

export type LiveEvaluationReport = {
  mode: "live-unavailable" | "live-simulated" | "live";
  suite: EvaluationSuite;
  requested_model?: string;
  configured_models: string[];
  timeout_ms: number;
  max_cases: number;
  calls_made: number;
  status: "unavailable" | "completed" | "cancelled" | "failed";
  reason: string;
  usage: "not-attempted" | "unknown" | "reported";
  aggregate_usage?: { input_tokens: number; output_tokens: number };
  results?: Array<{ id: string; output_chars: number; observed_outcome: ObservedOutcome; expected_outcome: ObservedOutcome; passed: boolean }>;
};

const MAX_OUTPUT_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 2_048;
function validModelId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value); }
function report(request: LiveEvaluationRequest, config: EvaluationConfig, reason: string, status: LiveEvaluationReport["status"] = "unavailable", calls = 0): LiveEvaluationReport {
  return { mode: "live-unavailable", suite: request.suite, requested_model: request.model?.trim() || undefined, configured_models: [...config.liveModels], timeout_ms: config.timeoutMs, max_cases: config.maxCases, calls_made: calls, status, reason, usage: calls ? "unknown" : "not-attempted" };
}
export function planLiveEvaluation(request: LiveEvaluationRequest, config: EvaluationConfig): LiveEvaluationReport {
  const model = request.model?.trim();
  if (!model) return report(request, config, "No exact live model was requested. No provider was contacted.");
  if (!validModelId(model)) return report(request, config, "The requested live model identifier is invalid; no provider was contacted.");
  if (!config.liveModels.includes(model)) return report(request, config, "The requested live model is not explicitly configured. Model/provider substitution is disabled and no provider was contacted.");
  return report(request, config, "Native confirmation and an exact authorized adapter are required before a model invocation.");
}

/** Executes an explicitly supplied exact adapter with a hard settlement deadline and host-only oracles. */
export async function runBoundedLiveEvaluation(request: LiveEvaluationRequest, config: EvaluationConfig, cases: readonly HostEvaluationCase[], adapter: LiveEvaluationAdapter | undefined, signal?: AbortSignal): Promise<LiveEvaluationReport> {
  const model = request.model?.trim();
  if (!model || !validModelId(model) || !config.liveModels.includes(model)) return planLiveEvaluation(request, config);
  if (!adapter || adapter.model !== model) return report(request, config, "No exact authorized adapter matches the configured model; no provider was contacted.");
  if (signal?.aborted) return report(request, config, "Live evaluation was cancelled before invocation.", "cancelled");
  const selected = cases.filter((item) => request.suite === "all" || item.suite === request.suite).slice(0, config.maxCases);
  if (!selected.length || new Set(selected.map((item) => item.id)).size !== selected.length) return report(request, config, "Selected fixture cases are empty or have duplicate IDs.", "failed");
  const controller = new AbortController();
  let abort: (() => void) | undefined;
  let callsMade = 0;
  const packet = { model, cases: selected.map(({ id, suite, prompt, source_context }) => ({ id, suite, prompt, ...(source_context ? { source_context } : {}) })), maxOutputChars: MAX_OUTPUT_CHARS, maxOutputTokens: MAX_OUTPUT_TOKENS };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invocation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Cancelled before adapter invocation.");
      callsMade = 1;
      return adapter.invoke(packet, controller.signal);
    }).then((value) => ({ kind: "result" as const, value }), (error) => ({ kind: "error" as const, error }));
    const deadline = new Promise<{ kind: "timeout" }>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, config.timeoutMs); });
    const callerAbort = new Promise<{ kind: "caller-abort" }>((resolve) => {
      abort = () => { controller.abort(); resolve({ kind: "caller-abort" }); };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    const settled = await Promise.race([invocation, deadline, callerAbort]);
    if (settled.kind === "timeout") return report(request, config, "Live evaluation exceeded its timeout; late adapter output was ignored.", "cancelled", callsMade);
    if (settled.kind === "caller-abort") return report(request, config, "Live evaluation was cancelled by the caller; late adapter output was ignored.", "cancelled", callsMade);
    if (settled.kind === "error") return report(request, config, `Adapter failed without substitution: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`, controller.signal.aborted ? "cancelled" : "failed", callsMade);
    if (controller.signal.aborted) return report(request, config, "Live evaluation was cancelled; adapter output was ignored.", "cancelled", callsMade);
    const adapterResult = settled.value;
    if (!adapterResult || typeof adapterResult !== "object") return report(request, config, "The adapter returned a malformed result packet.", "failed", callsMade);
    const hasAggregateResult = !Array.isArray(adapterResult);
    const aggregateResult = adapterResult as { results: ReadonlyArray<{ id: string; output: string }>; aggregate_usage?: { input_tokens: number; output_tokens: number } };
    const results = hasAggregateResult ? aggregateResult.results : adapterResult as ReadonlyArray<{ id: string; output: string }>;
    const aggregateUsage = hasAggregateResult ? aggregateResult.aggregate_usage : undefined;
    if (!Array.isArray(results) || results.length !== selected.length || new Set(results.map((item) => item?.id)).size !== selected.length || results.some((item) => !item || typeof item.id !== "string" || typeof item.output !== "string" || item.output.length > MAX_OUTPUT_CHARS || !selected.some((testCase) => testCase.id === item.id)) || (aggregateUsage !== undefined && (!aggregateUsage || typeof aggregateUsage !== "object" || !Number.isSafeInteger(aggregateUsage.input_tokens) || aggregateUsage.input_tokens < 0 || !Number.isSafeInteger(aggregateUsage.output_tokens) || aggregateUsage.output_tokens < 0 || aggregateUsage.output_tokens > MAX_OUTPUT_TOKENS))) return report(request, config, "The adapter returned duplicate, missing, malformed, or unbounded results.", "failed", 1);
    try {
      const evaluated = results.map((item) => { const fixture = selected.find((candidate) => candidate.id === item.id)!; const observed = fixture.evaluateOutput(item.output); return { id: item.id, output_chars: item.output.length, observed_outcome: observed, expected_outcome: fixture.expected_outcome, passed: observed === fixture.expected_outcome }; });
      return { mode: adapter.kind === "native" ? "live" : "live-simulated", suite: request.suite, requested_model: model, configured_models: [...config.liveModels], timeout_ms: config.timeoutMs, max_cases: config.maxCases, calls_made: 1, status: "completed", reason: "Executed through an explicitly injected exact-model adapter; host-only independent oracles scored returned outputs.", usage: aggregateUsage ? "reported" : "unknown", ...(aggregateUsage ? { aggregate_usage: aggregateUsage } : {}), results: evaluated };
    } catch (error) {
      return report(request, config, `Host oracle failed: ${error instanceof Error ? error.message : String(error)}`, "failed", 1);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
