/**
 * {@link CuaApi} on the `cua` CLI (open source, `trycua/cua`, CLI 0.7). The
 * CLI owns the user's cua.ai sign-in and cloud credentials; this adapter only
 * passes argv (never a shell line), bounds every call, validates the JSON it
 * prints, and redacts what it quotes in errors.
 *
 * Commands used (`--json` is a global flag):
 * - `cua --version`, `cua --json auth status` (no network), `cua --json auth whoami`
 * - `cua --json cloud status`, `cua --json cloud test <cloud>` (creates nothing)
 * - `cua --json sandbox create <image> --on <cloud> --name <name>`
 * - `cua --json sandbox info|ls|rm …`, `cua --json sandbox cp <file> <ref>:<path>`
 * - `cua sandbox exec -i [--cwd d] <ref> -- argv…` (argv, no shell; stdio streamed;
 *   the guest command is killed when the CLI process ends)
 *
 * Exit codes (CLI reference): 2 invalid argument, 3 not found, 4 not supported or
 * not configured, 5 transport, 6 unauthenticated, 7 disk, 8 no room, 130 cancelled.
 */
import type { CommandRunner, RunOptions, RunResult } from "../../runner/types.ts";
import { minimalEnv } from "../../runner/spawn.ts";
import { createLocalSpawner, type LocalSpawner } from "../../transport/local-process.ts";
import type { HelperProcess } from "../../transport/process.ts";
import {
  CuaApiError,
  type CloudLocation,
  type CloudProvider,
  type CloudTest,
  type CreateSandboxSpec,
  type CuaApi,
  type CuaErrorCode,
  type ExecOptions,
  type SandboxInfo,
} from "./api.ts";
import { redact } from "./redact.ts";

/** Upper bounds for CLI output and parsed values. */
export const CLI_LIMITS = {
  /** stdout/stderr of one short command. */
  outputBytes: 256 * 1024,
  /** stdout of `sandbox ls`. */
  listBytes: 4 * 1024 * 1024,
  sandboxes: 2_000,
  providers: 32,
  kinds: 256,
  checks: 256,
  idChars: 256,
  textChars: 4_096,
} as const;

/** Timeouts per command class (ms). */
export const CLI_TIMEOUTS = {
  quick: 15_000,
  network: 30_000,
  cloudTest: 90_000,
  /** `sandbox create` waits for readiness (CLI default 600 s + 120 s for cua-spacesd). */
  create: 15 * 60_000,
  delete: 5 * 60_000,
  upload: 10 * 60_000,
} as const;

/**
 * Variables handed to `cua` besides the runner's minimal set: its own
 * settings and the cloud SDKs' credential locations. `DISPLAY`/`WAYLAND_*`
 * never pass (R5); `CUA_NO_BROWSER=1` keeps the CLI from opening a browser.
 */
const PASS_PREFIXES = ["CUA_", "AWS_", "GOOGLE_", "CLOUDSDK_", "GCLOUD_", "HCLOUD_", "MODAL_"] as const;
const PASS_NAMES = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"] as const;
/** Passed through but never placed in an argv (the exit handler's `env` prefix). */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|KEY_ID|ACCESS_KEY|CREDENTIALS_JSON|SESSION)/;

/** The environment of every `cua` call (without the runner's inherited minimum). */
export function cuaEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PASS_PREFIXES.some((p) => key.startsWith(p)) || (PASS_NAMES as readonly string[]).includes(key)) env[key] = value;
  }
  env.CUA_NO_BROWSER = "1";
  env.CUA_KEYCHAIN_NONINTERACTIVE = "1";
  return env;
}

/** The non-secret part of {@link cuaEnv}, as `KEY=VALUE` words for an `env` argv prefix. */
export function nonSecretEnvWords(base: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(cuaEnv(base))
    .filter(([key, value]) => !SECRET_NAME.test(key) && !value.includes("\n"))
    .map(([key, value]) => `${key}=${value}`)
    .sort();
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCATION_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** Guest environment variable names a helper may receive. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface CuaCliApiOptions {
  runner: CommandRunner;
  /** Long-lived streams (`exec -i`); default {@link createLocalSpawner}. */
  spawner?: LocalSpawner;
  /** Executable; default `cua` from PATH. */
  executable?: string;
  /** Source environment; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

type Obj = Record<string, unknown>;

/** Shape checks for CLI JSON; failures are `BAD_RESPONSE`. */
class Shape {
  readonly #what: string;
  constructor(what: string) {
    this.#what = what;
  }
  fail(problem: string): never {
    throw new CuaApiError("BAD_RESPONSE", `cua ${this.#what} printed unexpected output (${problem}); update the cua CLI or report it`);
  }
  object(value: unknown, field: string): Obj {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(`${field} is not an object`);
    return value as Obj;
  }
  array(value: unknown, field: string, max: number): unknown[] {
    if (!Array.isArray(value)) this.fail(`${field} is not an array`);
    if (value.length > max) this.fail(`${field} has more than ${max} entries`);
    return value;
  }
  string(value: unknown, field: string, max: number = CLI_LIMITS.idChars): string {
    if (typeof value !== "string") this.fail(`${field} is not a string`);
    if (value.length > max) this.fail(`${field} is longer than ${max} characters`);
    return value;
  }
  optionalString(value: unknown, field: string, max?: number): string | undefined {
    return value === undefined || value === null ? undefined : this.string(value, field, max);
  }
  boolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") this.fail(`${field} is not a boolean`);
    return value;
  }
  optionalNumber(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) this.fail(`${field} is not a number in ${min}..${max}`);
    return value;
  }
  json(stdout: string): unknown {
    try {
      return JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "");
    } catch {
      this.fail("not JSON");
    }
  }
}

function sandboxFromJson(shape: Shape, value: unknown, field: string): SandboxInfo {
  const o = shape.object(value, field);
  const name = shape.string(o.name, `${field}.name`);
  if (!NAME_RE.test(name)) shape.fail(`${field}.name has unexpected characters`);
  const location = shape.string(o.location ?? "local", `${field}.location`, 64);
  if (!LOCATION_RE.test(location)) shape.fail(`${field}.location has unexpected characters`);
  const info: SandboxInfo = { name, location, status: shape.string(o.status ?? "unknown", `${field}.status`, 64) };
  const expiresAt = shape.optionalString(o.expires_at, `${field}.expires_at`, 64);
  if (expiresAt) info.expiresAt = expiresAt;
  const image = shape.optionalString(o.image, `${field}.image`, CLI_LIMITS.textChars);
  if (image) info.image = image;
  return info;
}

/** The production {@link CuaApi}: argv-only calls of the `cua` CLI. */
export class CuaCliApi implements CuaApi {
  readonly #runner: CommandRunner;
  readonly #spawner: LocalSpawner;
  readonly #cua: string;
  readonly #baseEnv: NodeJS.ProcessEnv;

  constructor(options: CuaCliApiOptions) {
    this.#runner = options.runner;
    this.#spawner = options.spawner ?? createLocalSpawner();
    this.#cua = options.executable ?? "cua";
    this.#baseEnv = options.baseEnv ?? process.env;
  }

  /** Runs `cua args…`; maps spawn failures, timeouts, and aborts to {@link CuaApiError}. */
  async #run(args: readonly string[], options: Omit<RunOptions, "env">): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.#runner.run([this.#cua, ...args], { maxOutputBytes: CLI_LIMITS.outputBytes, ...options, env: cuaEnv(this.#baseEnv) });
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e?.name === "AbortError") throw new CuaApiError("CANCELLED", "the cua command was cancelled");
      if (e?.code === "ENOENT") throw new CuaApiError("NO_CLI", `the cua CLI was not found on PATH (${this.#cua}); install it from https://cua.ai/docs/cua-cli`);
      throw new CuaApiError("FAILED", `cannot run cua: ${redact(e?.message ?? String(error))}`);
    }
    if (result.timedOut) throw new CuaApiError("TIMEOUT", `cua ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} did not finish within ${Math.round(options.timeoutMs / 1000)} s`);
    if (options.signal?.aborted) throw new CuaApiError("CANCELLED", "the cua command was cancelled");
    return result;
  }

  /** A failed result as an error with the CLI's documented class. */
  #failure(what: string, result: RunResult): CuaApiError {
    const codes: Record<number, CuaErrorCode> = { 3: "NOT_FOUND", 4: "UNSUPPORTED", 5: "TRANSPORT", 6: "AUTH", 130: "CANCELLED" };
    const code = (result.exitCode !== null && codes[result.exitCode]) || "FAILED";
    const detail = redact((result.stderr.trim() || result.stdout.trim()).split("\n").slice(-6).join("\n"));
    return new CuaApiError(code, `cua ${what} failed (exit ${result.exitCode ?? result.signal ?? "?"})${detail ? `: ${detail}` : ""}`);
  }

  #parse(what: string, result: RunResult): { shape: Shape; value: unknown } {
    const shape = new Shape(what);
    if (result.truncated) shape.fail("output exceeds the size limit");
    return { shape, value: shape.json(result.stdout) };
  }

  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.#run(["--version"], { timeoutMs: CLI_TIMEOUTS.quick, signal });
    if (result.exitCode !== 0) throw this.#failure("--version", result);
    const match = /(\d+\.\d+(?:\.\d+)?[\w.+-]*)/.exec(result.stdout);
    if (!match) throw new CuaApiError("BAD_RESPONSE", `cua --version printed no version (${redact(result.stdout.trim().slice(0, 200))})`);
    return match[1].slice(0, 64);
  }

  async signedIn(signal?: AbortSignal): Promise<{ signedIn: boolean; detail: string }> {
    const result = await this.#run(["--json", "auth", "status"], { timeoutMs: CLI_TIMEOUTS.quick, signal });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw this.#failure("auth status", result);
    const { shape, value } = this.#parse("auth status", result);
    const o = shape.object(value, "status");
    const signedIn = shape.boolean(o.logged_in, "logged_in");
    const expires = shape.optionalString(o.expires_at, "expires_at", 64);
    return { signedIn, detail: signedIn ? `signed in${expires ? ` (session expires ${expires})` : ""}` : "not signed in" };
  }

  async whoami(signal?: AbortSignal): Promise<{ account: string }> {
    const result = await this.#run(["--json", "auth", "whoami"], { timeoutMs: CLI_TIMEOUTS.network, signal });
    if (result.exitCode !== 0) {
      if (result.exitCode === 1 && /"authenticated"\s*:\s*false/.test(result.stdout)) throw new CuaApiError("AUTH", "not signed in to cua.ai; run `cua auth login` in a terminal");
      throw this.#failure("auth whoami", result);
    }
    const { shape, value } = this.#parse("auth whoami", result);
    const o = shape.object(value, "whoami");
    if (!shape.boolean(o.authenticated, "authenticated")) throw new CuaApiError("AUTH", "not signed in to cua.ai; run `cua auth login` in a terminal");
    const account = shape.optionalString(o.user, "user") ?? shape.optionalString(o.email, "email") ?? "signed in";
    const plan = shape.optionalString(o.plan, "plan", 64);
    return { account: plan ? `${account} (${plan})` : account };
  }

  async cloudStatus(signal?: AbortSignal): Promise<CloudProvider[]> {
    const result = await this.#run(["--json", "cloud", "status"], { timeoutMs: CLI_TIMEOUTS.network, signal });
    if (result.exitCode !== 0) throw this.#failure("cloud status", result);
    const { shape, value } = this.#parse("cloud status", result);
    const o = shape.object(value, "status");
    return shape.array(o.providers, "providers", CLI_LIMITS.providers).map((raw, i) => {
      const p = shape.object(raw, `providers[${i}]`);
      const credentials = p.credentials === undefined || p.credentials === null ? {} : shape.object(p.credentials, `providers[${i}].credentials`);
      const provider: CloudProvider = {
        name: shape.string(p.name, `providers[${i}].name`, 64),
        connected: shape.boolean(p.connected, `providers[${i}].connected`),
        isDefault: p.default === undefined ? false : shape.boolean(p.default, `providers[${i}].default`),
        credentialsFound: credentials.found === undefined ? false : shape.boolean(credentials.found, `providers[${i}].credentials.found`),
        kinds: (p.kinds === undefined ? [] : shape.array(p.kinds, `providers[${i}].kinds`, CLI_LIMITS.kinds)).map((rawKind, k) => {
          const field = `providers[${i}].kinds[${k}]`;
          const kind = shape.object(rawKind, field);
          const out = {
            image: shape.string(kind.image, `${field}.image`),
            kind: shape.string(kind.kind ?? "", `${field}.kind`, 64),
            supported: shape.boolean(kind.supported, `${field}.supported`),
          } as CloudProvider["kinds"][number];
          const reason = shape.optionalString(kind.reason, `${field}.reason`, CLI_LIMITS.textChars);
          if (reason) out.reason = reason;
          const machineType = shape.optionalString(kind.machine_type, `${field}.machine_type`);
          if (machineType) out.machineType = machineType;
          const usd = shape.optionalNumber(kind.usd_per_hour, `${field}.usd_per_hour`, 0, 10_000);
          if (usd !== undefined) out.usdPerHour = usd;
          return out;
        }),
      };
      const region = shape.optionalString(p.region, `providers[${i}].region`, 64);
      if (region) provider.region = region;
      const ttl = shape.optionalNumber(p.ttl_hours, `providers[${i}].ttl_hours`, 0, 100_000);
      if (ttl !== undefined) provider.ttlHours = ttl;
      return provider;
    });
  }

  async cloudTest(location: CloudLocation, signal?: AbortSignal): Promise<CloudTest> {
    const result = await this.#run(["--json", "cloud", "test", location], { timeoutMs: CLI_TIMEOUTS.cloudTest, signal });
    // Exit 1 with a JSON report means "not ready"; anything else without JSON is a failure.
    if (result.exitCode !== 0 && !(result.exitCode === 1 && result.stdout.trim().startsWith("{"))) throw this.#failure(`cloud test ${location}`, result);
    const { shape, value } = this.#parse("cloud test", result);
    const o = shape.object(value, "test");
    return {
      ok: shape.boolean(o.ok, "ok"),
      checks: (o.checks === undefined ? [] : shape.array(o.checks, "checks", CLI_LIMITS.checks)).map((raw, i) => {
        const c = shape.object(raw, `checks[${i}]`);
        return { name: shape.string(c.name, `checks[${i}].name`), ok: shape.boolean(c.ok, `checks[${i}].ok`), detail: redact(shape.string(c.detail ?? "", `checks[${i}].detail`, CLI_LIMITS.textChars)) };
      }),
    };
  }

  async createSandbox(spec: CreateSandboxSpec, signal?: AbortSignal): Promise<SandboxInfo> {
    if (!NAME_RE.test(spec.name)) throw new CuaApiError("FAILED", `invalid sandbox name ${JSON.stringify(spec.name)}`);
    if (spec.image.startsWith("-")) throw new CuaApiError("FAILED", `invalid image ${JSON.stringify(spec.image)}`);
    const result = await this.#run(["--json", "sandbox", "create", spec.image, "--on", spec.location, "--name", spec.name], { timeoutMs: CLI_TIMEOUTS.create, signal });
    if (result.exitCode !== 0) throw this.#failure(`sandbox create --on ${spec.location}`, result);
    const { shape, value } = this.#parse("sandbox create", result);
    const info = sandboxFromJson(shape, value, "sandbox");
    if (info.name !== spec.name) shape.fail(`created sandbox is named ${JSON.stringify(info.name)}, not ${JSON.stringify(spec.name)}`);
    return info;
  }

  async getSandbox(ref: string, signal?: AbortSignal): Promise<SandboxInfo | undefined> {
    const result = await this.#run(["--json", "sandbox", "info", ref], { timeoutMs: CLI_TIMEOUTS.network, signal });
    if (result.exitCode === 3) return undefined;
    if (result.exitCode !== 0) throw this.#failure("sandbox info", result);
    const { shape, value } = this.#parse("sandbox info", result);
    return sandboxFromJson(shape, value, "sandbox");
  }

  async listSandboxes(signal?: AbortSignal): Promise<SandboxInfo[]> {
    const result = await this.#run(["--json", "sandbox", "ls", "--no-size"], { timeoutMs: CLI_TIMEOUTS.network, signal, maxOutputBytes: CLI_LIMITS.listBytes });
    if (result.exitCode !== 0) throw this.#failure("sandbox ls", result);
    const { shape, value } = this.#parse("sandbox ls", result);
    return shape.array(value, "sandboxes", CLI_LIMITS.sandboxes).map((raw, i) => sandboxFromJson(shape, raw, `sandboxes[${i}]`));
  }

  async deleteSandbox(ref: string, signal?: AbortSignal): Promise<{ missing: boolean }> {
    const result = await this.#run(["--json", "sandbox", "rm", ref, "--force"], { timeoutMs: CLI_TIMEOUTS.delete, signal });
    if (result.exitCode === 3) return { missing: true };
    if (result.exitCode !== 0) throw this.#failure("sandbox rm", result);
    const { shape, value } = this.#parse("sandbox rm", result);
    const o = shape.object(value, "rm");
    return { missing: o.missing === undefined ? false : shape.boolean(o.missing, "missing") };
  }

  async exec(ref: string, argv: readonly string[], options: ExecOptions): Promise<RunResult> {
    if (argv.length === 0) throw new CuaApiError("FAILED", "empty argv");
    const result = await this.#run(["sandbox", "exec", "-i", ...(options.cwd ? ["--cwd", options.cwd] : []), ref, "--", ...argv], {
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The CLI's own failures (no sandbox, transport, auth) are not the command's exit status.
    if (result.exitCode !== null && [3, 5, 6].includes(result.exitCode) && /^error|cua:/im.test(result.stderr)) throw this.#failure("sandbox exec", result);
    return { ...result, stdout: result.stdout, stderr: redact(result.stderr) };
  }

  async upload(ref: string, localPath: string, guestPath: string, signal?: AbortSignal): Promise<{ size: number }> {
    if (!guestPath.startsWith("/")) throw new CuaApiError("FAILED", `guest path must be absolute: ${guestPath}`);
    const result = await this.#run(["--json", "sandbox", "cp", localPath, `${ref}:${guestPath}`], { timeoutMs: CLI_TIMEOUTS.upload, signal });
    if (result.exitCode !== 0) throw this.#failure("sandbox cp", result);
    const { shape, value } = this.#parse("sandbox cp", result);
    const o = shape.object(value, "cp");
    return { size: shape.optionalNumber(o.size, "size", 0, Number.MAX_SAFE_INTEGER) ?? 0 };
  }

  spawnHelper(ref: string, argv: readonly string[], env: Readonly<Record<string, string>>): HelperProcess {
    const { script, lines } = envPreamble(env);
    const child = this.#spawner.spawn(
      [this.#cua, "sandbox", "exec", "-i", ref, "--", "sh", "-c", script, "sh", ...argv],
      { env: minimalEnv(this.#baseEnv, cuaEnv(this.#baseEnv)) },
    );
    // `exec -i` forwards stdin: the guest shell reads the values before anything else arrives.
    if (lines) child.stdin.write(lines);
    return child;
  }

  forceDeleteArgv(ref: string): string[] {
    const words = nonSecretEnvWords(this.#baseEnv);
    return [...(words.length ? ["env", ...words] : []), this.#cua, "sandbox", "rm", ref, "--force"];
  }
}

/**
 * A guest shell preamble that reads `env` values from the first stdin lines
 * and exports them, then `exec`s the argv given after the script. Values thus
 * never appear in any argv, local or remote.
 *
 * @throws CuaApiError for a name that is not a plain variable name or a value with a newline.
 */
export function envPreamble(env: Readonly<Record<string, string>>): { script: string; lines: string } {
  const keys = Object.keys(env).sort();
  for (const key of keys) {
    if (!ENV_NAME_RE.test(key)) throw new CuaApiError("FAILED", `invalid environment variable name ${JSON.stringify(key)}`);
    if (/[\r\n\0]/.test(env[key])) throw new CuaApiError("FAILED", `environment value of ${key} contains a line break`);
  }
  const reads = keys.map((key) => `IFS= read -r ${key} && export ${key} && `).join("");
  return { script: `${reads}exec "$@"`, lines: keys.map((key) => `${env[key]}\n`).join("") };
}
