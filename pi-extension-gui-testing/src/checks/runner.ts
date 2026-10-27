/**
 * Check runner (spec §5.2 step 3, §5.3): dependency order, independent checks
 * in parallel, a timeout per check, `blocked` for dependents of failures, and
 * `warn` + `degrades` for optional checks.
 */
import type { CommandRunner, DockerEndpoint } from "../runner/types.ts";
import { DEFAULT_CHECK_TIMEOUT_MS, type Check, type CheckContext, type CheckOutcome, type CheckResult } from "./types.ts";

/** A programming error in a backend's check list (duplicate id, unknown dependency, cycle). */
export class CheckGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckGraphError";
  }
}

/**
 * Validates the dependency graph and returns the ids in a dependency-respecting
 * order (declaration order among independent checks).
 *
 * @throws CheckGraphError for duplicate ids, unknown dependencies, or cycles.
 */
export function orderChecks(checks: readonly Check[]): string[] {
  const byId = new Map<string, Check>();
  for (const check of checks) {
    if (byId.has(check.id)) throw new CheckGraphError(`duplicate check id "${check.id}"`);
    byId.set(check.id, check);
  }
  for (const check of checks) {
    for (const dep of check.dependsOn ?? []) {
      if (!byId.has(dep)) throw new CheckGraphError(`check "${check.id}" depends on unknown check "${dep}"`);
      if (dep === check.id) throw new CheckGraphError(`check "${check.id}" depends on itself`);
    }
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") throw new CheckGraphError(`dependency cycle: ${[...path, id].join(" → ")}`);
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep, [...path, id]);
    state.set(id, "done");
    order.push(id);
  };
  for (const check of checks) visit(check.id, []);
  return order;
}

export interface RunChecksOptions {
  runner: CommandRunner;
  backend: string;
  projectRoot: string;
  /** Aborting it stops the run; {@link runChecks} then rejects with the abort reason. */
  signal: AbortSignal;
  /**
   * Derives the Docker endpoint from completed results, for checks that run
   * after `docker.endpoint`. Defaults to {@link endpointFromFacts}.
   */
  endpointFrom?: (results: ReadonlyMap<string, CheckResult>) => DockerEndpoint | undefined;
  /** Called as each check finishes, for progress display. */
  onResult?: (result: CheckResult) => void;
}

/** Id of the check whose facts carry the session's Docker endpoint. */
export const ENDPOINT_CHECK_ID = "docker.endpoint";

/**
 * Default endpoint derivation: a passed `docker.endpoint` result with facts
 * `context` and `host`.
 */
export function endpointFromFacts(results: ReadonlyMap<string, CheckResult>): DockerEndpoint | undefined {
  const result = results.get(ENDPOINT_CHECK_ID);
  const context = result?.facts?.context;
  const host = result?.facts?.host;
  if (result?.status !== "pass" || !context || !host) return undefined;
  return { context, host };
}

class CheckTimeout extends Error {}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(typeof reason === "string" ? reason : "check run aborted"), { name: "AbortError" });
}

/**
 * Runs `checks` and returns one result per check, in the given order.
 *
 * - A check starts as soon as all its dependencies finished; independent checks run concurrently.
 * - A dependency that failed or is blocked (including an optional dependency
 *   whose failure was downgraded to `warn`) makes the dependent `blocked`, with `blockedBy`.
 * - A check exceeding its timeout, or throwing, fails with the reason as `observed`.
 * - An optional check that fails reports `warn` with its `degrades`.
 *
 * @throws CheckGraphError for an invalid graph (before running anything).
 * @throws The abort reason when `signal` aborts; no partial results are returned.
 */
export async function runChecks(checks: readonly Check[], options: RunChecksOptions): Promise<CheckResult[]> {
  orderChecks(checks);
  const { signal } = options;
  if (signal.aborted) throw abortError(signal);
  const endpointFrom = options.endpointFrom ?? endpointFromFacts;
  const results = new Map<string, CheckResult>();
  /** Checks whose own outcome was `fail`, even if reported as `warn`. */
  const failed = new Set<string>();
  const started = new Set<string>();

  return new Promise<CheckResult[]>((resolve, reject) => {
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const complete = (result: CheckResult, outcomeFailed: boolean) => {
      if (finished) return;
      results.set(result.id, result);
      if (outcomeFailed || result.status === "blocked") failed.add(result.id);
      options.onResult?.(result);
      schedule();
    };

    const schedule = () => {
      if (finished) return;
      for (const check of checks) {
        if (started.has(check.id)) continue;
        const deps = check.dependsOn ?? [];
        if (!deps.every((d) => results.has(d))) continue;
        started.add(check.id);
        const blockedBy = deps.filter((d) => failed.has(d));
        if (blockedBy.length > 0) {
          complete(
            {
              id: check.id,
              status: "blocked",
              observed: `blocked by ${blockedBy.join(", ")}`,
              required: check.required,
              durationMs: 0,
              blockedBy,
            },
            false,
          );
          continue;
        }
        const dependencies = new Map(deps.map((d) => [d, results.get(d)!] as const));
        void runOne(check, options, dependencies, endpointFrom(results)).then((r) => complete(r.result, r.failed));
      }
      if (results.size === checks.length && !finished) {
        finished = true;
        signal.removeEventListener("abort", onAbort);
        resolve(checks.map((c) => results.get(c.id)!));
      }
    };
    schedule();
  });
}

async function runOne(
  check: Check,
  options: RunChecksOptions,
  dependencies: ReadonlyMap<string, CheckResult>,
  dockerEndpoint: DockerEndpoint | undefined,
): Promise<{ result: CheckResult; failed: boolean }> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const forward = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", forward, { once: true });
  const ctx: CheckContext = {
    runner: options.runner,
    signal: controller.signal,
    backend: options.backend,
    dependencies,
    projectRoot: options.projectRoot,
  };
  if (dockerEndpoint) ctx.dockerEndpoint = dockerEndpoint;
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let outcome: CheckOutcome;
  try {
    // Racing guarantees the bound even for a check that ignores its signal.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new CheckTimeout(`timed out after ${timeoutMs} ms`));
        reject(new CheckTimeout(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    outcome = validOutcome(await Promise.race([Promise.resolve().then(() => check.run(ctx)), timeout]));
  } catch (error) {
    outcome = { status: "fail", observed: (error as Error)?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", forward);
  }
  const durationMs = Date.now() - start;
  const outcomeFailed = outcome.status === "fail";
  const result: CheckResult = {
    id: check.id,
    status: outcomeFailed && !check.required ? "warn" : outcome.status,
    observed: outcome.observed,
    required: check.required,
    durationMs,
  };
  if (outcome.facts) result.facts = outcome.facts;
  if (outcomeFailed && check.remediation) result.remediation = check.remediation;
  if (outcomeFailed && !check.required && check.degrades) result.degrades = check.degrades;
  return { result, failed: outcomeFailed };
}

function validOutcome(value: unknown): CheckOutcome {
  const outcome = value as CheckOutcome | undefined;
  if (!outcome || !["pass", "warn", "fail"].includes(outcome.status)) {
    return { status: "fail", observed: `check returned an invalid outcome: ${JSON.stringify(value)}` };
  }
  return { ...outcome, observed: typeof outcome.observed === "string" ? outcome.observed : String(outcome.observed) };
}

/** `true` when every required check passed or warned. */
export function requiredChecksPass(results: readonly CheckResult[]): boolean {
  return results.every((r) => !r.required || r.status === "pass" || r.status === "warn");
}
