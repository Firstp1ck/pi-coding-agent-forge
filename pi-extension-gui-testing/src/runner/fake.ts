/**
 * Scriptable {@link CommandRunner} for unit tests (checks, backends, setup).
 * Never spawns anything.
 */
import type { CommandRunner, RunOptions, RunResult } from "./types.ts";

/** How a rule recognises a command. */
export type ArgvMatcher =
  /** Exact argv, or an argv prefix when the rule sets `prefix`. */
  | readonly string[]
  /** Tested against the argv joined with single spaces. */
  | RegExp
  | ((argv: readonly string[]) => boolean);

/** What a matching rule returns: a partial result, an error to reject with, or a function producing either. */
export type FakeResponse =
  | Partial<RunResult>
  | Error
  | ((argv: readonly string[], options: RunOptions) => Partial<RunResult> | Error | Promise<Partial<RunResult> | Error>);

export interface FakeRule {
  match: ArgvMatcher;
  response: FakeResponse;
  /** Treat an array matcher as a prefix. */
  prefix?: boolean;
  /** Remove the rule after its first use. */
  once?: boolean;
  /** Simulated run time; the run honours `timeoutMs` and `signal` like a real child. */
  delayMs?: number;
}

export interface RecordedCall {
  argv: string[];
  options: RunOptions;
}

/**
 * Fake runner. Later rules take precedence over earlier ones, so a test can
 * override a default. An unmatched command rejects (like a missing executable)
 * with a message naming the argv, so a missing stub is obvious.
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  #rules: FakeRule[] = [];

  /** Adds a rule and returns `this` for chaining. */
  on(match: ArgvMatcher, response: FakeResponse, options: Omit<FakeRule, "match" | "response"> = {}): this {
    this.#rules.push({ match, response, ...options });
    return this;
  }

  /** Argvs of every recorded call, joined with spaces (handy for assertions). */
  commands(): string[] {
    return this.calls.map((call) => call.argv.join(" "));
  }

  async run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
    this.calls.push({ argv: [...argv], options });
    if (options.signal?.aborted) throw Object.assign(new Error("aborted before spawn"), { name: "AbortError" });
    const index = this.#findRule(argv);
    if (index === -1) throw Object.assign(new Error(`FakeCommandRunner: no rule for: ${argv.join(" ")}`), { code: "ENOENT" });
    const rule = this.#rules[index];
    if (rule.once) this.#rules.splice(index, 1);

    const started = Date.now();
    if (rule.delayMs !== undefined && rule.delayMs > 0) {
      const interrupted = await delay(rule.delayMs, options);
      if (interrupted) {
        return {
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          timedOut: interrupted === "timeout",
          truncated: false,
          durationMs: Date.now() - started,
        };
      }
    }
    const produced = typeof rule.response === "function" ? await rule.response(argv, options) : rule.response;
    if (produced instanceof Error) throw produced;
    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      durationMs: Date.now() - started,
      ...produced,
    };
  }

  #findRule(argv: readonly string[]): number {
    for (let i = this.#rules.length - 1; i >= 0; i--) {
      if (matches(this.#rules[i], argv)) return i;
    }
    return -1;
  }
}

function matches(rule: FakeRule, argv: readonly string[]): boolean {
  const { match } = rule;
  if (typeof match === "function") return match(argv);
  if (match instanceof RegExp) return match.test(argv.join(" "));
  if (rule.prefix ? argv.length < match.length : argv.length !== match.length) return false;
  return match.every((part, i) => argv[i] === part);
}

function delay(ms: number, options: RunOptions): Promise<"timeout" | "abort" | undefined> {
  return new Promise((resolve) => {
    const done = (value: "timeout" | "abort" | undefined) => {
      clearTimeout(timer);
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => done("abort");
    const timer = setTimeout(() => done(undefined), ms);
    const timeout = setTimeout(() => done("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
