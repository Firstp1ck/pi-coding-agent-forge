/**
 * Argument parsing for the slash commands (spec §5.1, §7a.5). Pi passes command
 * arguments as one string; these parsers turn it into typed options and reject
 * anything unknown with the list of valid flags.
 */
import { CLOUD_LOCATIONS, type CloudLocation } from "../backends/cua/api.ts";
import type { BackendId, TargetOs } from "./types.ts";
import { ALL_BACKENDS, TARGET_OSES } from "./validate.ts";

/** Invalid command arguments; the message is shown to the user as-is. */
export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

/**
 * Splits an argument string on whitespace, honouring single and double quotes
 * and backslash escapes outside single quotes, so paths with spaces work.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new FlagError(`unterminated ${quote} quote in arguments`);
  if (inToken) tokens.push(current);
  return tokens;
}

interface FlagSpec {
  /** `true` when the flag takes a value (`--host x` or `--host=x`). */
  value: boolean;
}

interface Parsed {
  flags: Map<string, string | true>;
  positionals: string[];
}

function parseTokens(command: string, tokens: string[], specs: Record<string, FlagSpec>): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const valid = Object.keys(specs);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const spec = specs[name];
    if (!spec) {
      const list = valid.length > 0 ? valid.join(", ") : "none";
      throw new FlagError(`${command}: unknown flag ${name}; valid flags: ${list}`);
    }
    if (flags.has(name)) throw new FlagError(`${command}: ${name} given more than once`);
    if (spec.value) {
      const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
        throw new FlagError(`${command}: ${name} needs a value`);
      }
      flags.set(name, value);
    } else {
      if (eq !== -1) throw new FlagError(`${command}: ${name} takes no value`);
      flags.set(name, true);
    }
  }
  return { flags, positionals };
}

function maxPositionals(command: string, positionals: string[], max: number, usage: string): void {
  if (positionals.length > max) throw new FlagError(`${command}: unexpected argument "${positionals[max]}"; usage: ${usage}`);
}

/**
 * Validates a backend id from user input.
 *
 * @throws FlagError listing the known backend ids.
 */
export function parseBackendId(command: string, value: string): BackendId {
  if (!ALL_BACKENDS.includes(value as BackendId)) {
    throw new FlagError(`${command}: unknown backend "${value}"; known backends: ${ALL_BACKENDS.join(", ")}`);
  }
  return value as BackendId;
}

/** Options of `/gui-setup [backend] [flags]`. */
export interface SetupArgs {
  backend?: BackendId;
  host?: string;
  targets?: TargetOs[];
  apiKeyEnv?: string;
  acceptBilling: boolean;
  acceptWindowsLicense: boolean;
  fix: boolean;
  noFix: boolean;
  project: boolean;
  purgeTooling: boolean;
  /** `cua`: the cloud for sandboxes (`--cloud`). */
  cloud?: CloudLocation;
  /** `cua`: hourly sandbox price for the cost estimate when Cua reports none (`--rate-usd-per-hour`). */
  rateUsdPerHour?: number;
  /** `cua`: the sandbox image (`--image`, default Cua's `linux` image). */
  image?: string;
}

export const SETUP_FLAGS: Record<string, FlagSpec> = {
  "--host": { value: true },
  "--targets": { value: true },
  "--api-key-env": { value: true },
  "--accept-billing": { value: false },
  "--accept-windows-license": { value: false },
  "--fix": { value: false },
  "--no-fix": { value: false },
  "--project": { value: false },
  "--purge-tooling": { value: false },
  "--cloud": { value: true },
  "--rate-usd-per-hour": { value: true },
  "--image": { value: true },
};

export const SETUP_USAGE =
  "/gui-setup [backend] [--fix|--no-fix] [--project] [--host <ssh-alias-or-user@host>] [--purge-tooling] [--targets linux,windows,macos] [--accept-billing] [--cloud aws|gcp|hetzner|modal] [--rate-usd-per-hour <n>] [--image <cua-image>] [--accept-windows-license]";

/** Parses `/gui-setup` arguments. `--fix` and `--no-fix` are mutually exclusive. */
export function parseSetupArgs(input: string): SetupArgs {
  const command = "/gui-setup";
  const { flags, positionals } = parseTokens(command, tokenizeArgs(input), SETUP_FLAGS);
  maxPositionals(command, positionals, 1, SETUP_USAGE);
  if (flags.has("--fix") && flags.has("--no-fix")) throw new FlagError(`${command}: --fix and --no-fix cannot be combined`);
  const args: SetupArgs = {
    acceptBilling: flags.has("--accept-billing"),
    acceptWindowsLicense: flags.has("--accept-windows-license"),
    fix: flags.has("--fix"),
    noFix: flags.has("--no-fix"),
    project: flags.has("--project"),
    purgeTooling: flags.has("--purge-tooling"),
  };
  if (positionals[0] !== undefined) args.backend = parseBackendId(command, positionals[0]);
  const host = flags.get("--host");
  if (typeof host === "string") args.host = host;
  const apiKeyEnv = flags.get("--api-key-env");
  if (typeof apiKeyEnv === "string") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new FlagError(`${command}: --api-key-env must be an environment variable name`);
    args.apiKeyEnv = apiKeyEnv;
  }
  const cloud = flags.get("--cloud");
  if (typeof cloud === "string") {
    if (!(CLOUD_LOCATIONS as readonly string[]).includes(cloud)) throw new FlagError(`${command}: unknown cloud "${cloud}"; valid clouds: ${CLOUD_LOCATIONS.join(", ")}`);
    args.cloud = cloud as CloudLocation;
  }
  const rate = flags.get("--rate-usd-per-hour");
  if (typeof rate === "string") {
    const value = Number(rate);
    if (!/^\d+(\.\d+)?$/.test(rate) || !Number.isFinite(value) || value > 1_000) throw new FlagError(`${command}: --rate-usd-per-hour must be a number from 0 to 1000 (USD per sandbox hour)`);
    args.rateUsdPerHour = value;
  }
  const image = flags.get("--image");
  if (typeof image === "string") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(image)) throw new FlagError(`${command}: --image must be an image alias or registry reference (letters, digits, and . _ : / @ -)`);
    args.image = image;
  }
  const targets = flags.get("--targets");
  if (typeof targets === "string") {
    const list = targets.split(",").map((t) => t.trim()).filter(Boolean);
    for (const t of list) {
      if (!(TARGET_OSES as readonly string[]).includes(t)) {
        throw new FlagError(`${command}: unknown target "${t}"; valid targets: ${TARGET_OSES.join(", ")}`);
      }
    }
    if (list.length === 0) throw new FlagError(`${command}: --targets needs at least one target`);
    args.targets = [...new Set(list)] as TargetOs[];
  }
  return args;
}

/** Parses `/gui-doctor [backend] [--host <host>]`. */
export function parseDoctorArgs(input: string): { backend?: BackendId; host?: string } {
  const command = "/gui-doctor";
  const { flags, positionals } = parseTokens(command, tokenizeArgs(input), { "--host": { value: true } });
  maxPositionals(command, positionals, 1, "/gui-doctor [backend] [--host <ssh-alias-or-user@host>]");
  const result: { backend?: BackendId; host?: string } = {};
  if (positionals[0] !== undefined) result.backend = parseBackendId(command, positionals[0]);
  const host = flags.get("--host");
  if (typeof host === "string") result.host = host;
  return result;
}

/** Parses `/gui-backend <id> [--project]`. */
export function parseBackendArgs(input: string): { backend: BackendId; project: boolean } {
  const command = "/gui-backend";
  const usage = "/gui-backend <backend> [--project]";
  const { flags, positionals } = parseTokens(command, tokenizeArgs(input), { "--project": { value: false } });
  maxPositionals(command, positionals, 1, usage);
  if (positionals[0] === undefined) throw new FlagError(`${command}: missing backend; usage: ${usage}`);
  return { backend: parseBackendId(command, positionals[0]), project: flags.has("--project") };
}

/** Parses `/gui-usage [session]`. */
export function parseUsageArgs(input: string): { session?: string } {
  const command = "/gui-usage";
  const { positionals } = parseTokens(command, tokenizeArgs(input), {});
  maxPositionals(command, positionals, 1, "/gui-usage [session]");
  return positionals[0] === undefined ? {} : { session: positionals[0] };
}

/** Parses `/gui-cleanup [backend|--all] [--deps]`. Without a backend or `--all`, the caller uses the active backend. */
export function parseCleanupArgs(input: string): { backend?: BackendId; all: boolean; deps: boolean } {
  const command = "/gui-cleanup";
  const usage = "/gui-cleanup [backend|--all] [--deps]";
  const { flags, positionals } = parseTokens(command, tokenizeArgs(input), {
    "--all": { value: false },
    "--deps": { value: false },
  });
  maxPositionals(command, positionals, 1, usage);
  const all = flags.has("--all");
  if (all && positionals[0] !== undefined) throw new FlagError(`${command}: give a backend or --all, not both; usage: ${usage}`);
  const result: { backend?: BackendId; all: boolean; deps: boolean } = { all, deps: flags.has("--deps") };
  if (positionals[0] !== undefined) result.backend = parseBackendId(command, positionals[0]);
  return result;
}

/** Parses `/gui-reset <backend>`. */
export function parseResetArgs(input: string): { backend: BackendId } {
  const command = "/gui-reset";
  const usage = "/gui-reset <backend>";
  const { positionals } = parseTokens(command, tokenizeArgs(input), {});
  maxPositionals(command, positionals, 1, usage);
  if (positionals[0] === undefined) throw new FlagError(`${command}: missing backend; usage: ${usage}`);
  return { backend: parseBackendId(command, positionals[0]) };
}

/** Parses `/gui-export <session> <dest>`. */
export function parseExportArgs(input: string): { session: string; dest: string } {
  const command = "/gui-export";
  const usage = "/gui-export <session> <dest>";
  const { positionals } = parseTokens(command, tokenizeArgs(input), {});
  maxPositionals(command, positionals, 2, usage);
  if (positionals.length < 2) throw new FlagError(`${command}: missing ${positionals.length === 0 ? "session and destination" : "destination"}; usage: ${usage}`);
  return { session: positionals[0], dest: positionals[1] };
}
