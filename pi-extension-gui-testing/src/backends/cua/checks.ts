/**
 * `cua` checks (spec §5.4, adapted to Cua after Cua Cloud ended on
 * 2026-10-18): the `cua` CLI, network, cua.ai sign-in, a connected cloud of
 * the user's, its read-only account test, requested targets, sandbox expiry,
 * an hourly rate, and the billing + upload acknowledgement. Every check is
 * `observe`: nothing is created and nothing is billed. The package never
 * handles a credential: sign-in and cloud credentials stay in the `cua` CLI.
 */
import { loadResolvedConfig } from "../../config/load.ts";
import type { TargetOs } from "../../config/types.ts";
import { commonChecks, type CommonCheckOptions } from "../../checks/common.ts";
import type { Check, CheckOutcome } from "../../checks/types.ts";
import type { HostSupport } from "../host-support.ts";
import { CuaApiError, isCloudLocation, type CloudLocation, type CloudProvider, type CuaApi } from "./api.ts";
import { reportedRate } from "./cost.ts";
import { redact } from "./redact.ts";
import { DEFAULT_IMAGE, type CuaSettings } from "./settings.ts";

/** How long checks of one run reuse a `cua cloud status` answer (ms). */
const STATUS_REUSE_MS = 10_000;

/** Free space for staging the workspace and helper archives. */
export const CUA_MIN_FREE_BYTES = 1024 ** 3;

/** Client platforms in this build (owner identity and the sweep read `/proc`). */
export const CUA_HOST_SUPPORT: HostSupport = {
  platforms: ["linux"],
  otherwise: "cua runs from Linux clients in this version; macOS and Windows clients are planned",
};

/** Targets in this build; the others need the Windows helper (spike S1) or are planned. */
export const CUA_TARGETS: readonly TargetOs[] = ["linux"];

export function targetRefusal(target: TargetOs): string | undefined {
  if (target === "linux") return undefined;
  if (target === "windows") return "windows: needs the Windows helper (spike S1); planned";
  return "macos: needs the macOS support of the Windows/macOS helper work; planned";
}

/** Default reachability probe: any HTTP answer from the Cua API host counts (no credentials sent). */
export async function probeCuaNetwork(signal: AbortSignal, url: string = process.env.CUA_SPACES_API_URL || "https://api.cua.ai/"): Promise<string> {
  const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  await response.body?.cancel().catch(() => undefined);
  return `${new URL(url).host} answered HTTP ${response.status}`;
}

export interface CuaCheckOptions {
  api: CuaApi;
  /** Current settings (cloud, image, rate, acknowledgement). */
  settings: () => Promise<CuaSettings>;
  /** Targets requested by `--targets` or the project's `targets`; default: the project's. */
  targets?: (projectRoot: string) => Promise<readonly TargetOs[]>;
  /** Reachability probe; default {@link probeCuaNetwork}. */
  probeNetwork?: (signal: AbortSignal) => Promise<string>;
  common?: Partial<CommonCheckOptions>;
}

/** Cloud of the sandboxes: the setup choice, else the cloud `cua cloud connect --default` chose. */
export function chooseLocation(settings: CuaSettings, providers: readonly CloudProvider[]): { location?: CloudLocation; why: string } {
  if (settings.location) return { location: settings.location, why: "chosen at setup" };
  const defaults = providers.filter((p) => p.isDefault && p.connected && isCloudLocation(p.name));
  if (defaults.length === 1) return { location: defaults[0].name as CloudLocation, why: "the cua default cloud" };
  const connected = providers.filter((p) => p.connected && isCloudLocation(p.name));
  if (connected.length === 1) return { location: connected[0].name as CloudLocation, why: "the only connected cloud" };
  return { why: connected.length === 0 ? "no cloud is connected" : `${connected.length} clouds are connected and none is the default` };
}

function fail(observed: string): CheckOutcome {
  return { status: "fail", observed };
}

function apiProblem(error: unknown): string {
  return error instanceof CuaApiError ? error.message : redact((error as Error)?.message ?? String(error));
}

/** The common checks plus the `cua` checks, in dependency order. */
export function cuaChecks(options: CuaCheckOptions): Check[] {
  const { api } = options;
  // Checks of one run share a `cloud status` answer for a few seconds; a failure is not reused.
  let status: { at: number; value: Promise<CloudProvider[]> } | undefined;
  const cloudStatus = (signal: AbortSignal): Promise<CloudProvider[]> => {
    if (status && Date.now() - status.at < STATUS_REUSE_MS) return status.value;
    const value = api.cloudStatus(signal);
    status = { at: Date.now(), value };
    value.catch(() => {
      if (status?.value === value) status = undefined;
    });
    return value;
  };
  const location = async (signal: AbortSignal) => chooseLocation(await options.settings(), await cloudStatus(signal));
  const targets = options.targets ?? ((projectRoot: string) => projectTargets(projectRoot).catch(() => [] as TargetOs[]));

  return [
    ...commonChecks("cua", { minFreeBytes: CUA_MIN_FREE_BYTES, hostSupport: CUA_HOST_SUPPORT, ...options.common }),
    {
      id: "cua.cli",
      description: "the cua CLI is installed",
      kind: "observe",
      required: true,
      remediation: { summary: "Install the cua CLI (https://cua.ai/docs/cua-cli), then run /gui-setup cua again", manual: true },
      async run(ctx) {
        try {
          const version = await api.version(ctx.signal);
          return { status: "pass", observed: `cua ${version}`, facts: { "cua.cli": version } };
        } catch (error) {
          return fail(apiProblem(error));
        }
      },
    },
    {
      id: "cua.network",
      description: "the Cua service is reachable",
      kind: "observe",
      required: true,
      remediation: { summary: "Check the network connection and any proxy settings (HTTPS_PROXY) for api.cua.ai", manual: true },
      async run(ctx) {
        try {
          return { status: "pass", observed: await (options.probeNetwork ?? probeCuaNetwork)(ctx.signal) };
        } catch (error) {
          return fail(`unreachable: ${redact((error as Error)?.message ?? String(error))}`);
        }
      },
    },
    {
      id: "cua.signin",
      description: "signed in to cua.ai (cua auth status, no network)",
      kind: "observe",
      required: true,
      dependsOn: ["cua.cli"],
      remediation: { summary: "Run `cua auth login` in a terminal (browser sign-in; `--remote` over SSH). Pi never sees the credentials", manual: true },
      async run(ctx) {
        try {
          const state = await api.signedIn(ctx.signal);
          return { status: state.signedIn ? "pass" : "fail", observed: state.detail };
        } catch (error) {
          return fail(apiProblem(error));
        }
      },
    },
    {
      id: "cua.auth",
      description: "an authenticated read-only Cua call succeeds",
      kind: "observe",
      required: true,
      dependsOn: ["cua.signin", "cua.network"],
      remediation: { summary: "Sign in again with `cua auth login` in a terminal", manual: true },
      async run(ctx) {
        try {
          return { status: "pass", observed: `signed in as ${(await api.whoami(ctx.signal)).account}` };
        } catch (error) {
          return fail(apiProblem(error));
        }
      },
    },
    {
      id: "cua.cloud",
      description: "a cloud account of yours is connected for sandboxes",
      kind: "observe",
      required: true,
      dependsOn: ["cua.auth"],
      remediation: { summary: "Connect one: `cua cloud connect aws --region us-west-2 --default` (or gcp, hetzner, modal); see https://cua.ai/docs/cua-sdk/guides/your-cloud", manual: true },
      async run(ctx) {
        let providers: CloudProvider[];
        try {
          providers = await cloudStatus(ctx.signal);
        } catch (error) {
          return fail(apiProblem(error));
        }
        const chosen = chooseLocation(await options.settings(), providers);
        if (!chosen.location) return fail(chosen.why);
        const provider = providers.find((p) => p.name === chosen.location);
        if (!provider?.connected) return fail(`${chosen.location} (${chosen.why}) is not connected`);
        if (!provider.credentialsFound) return fail(`${chosen.location}: no cloud credentials found on this machine`);
        return {
          status: "pass",
          observed: `${chosen.location}${provider.region ? ` ${provider.region}` : ""} (${chosen.why})`,
          facts: { "cua.location": chosen.location, ...(provider.region ? { "cua.region": provider.region } : {}) },
        };
      },
    },
    {
      id: "cua.quota",
      description: "the cloud account passes Cua's read-only test (credentials, permissions, quota, region)",
      kind: "observe",
      required: true,
      dependsOn: ["cua.cloud"],
      timeoutMs: 120_000,
      remediation: { summary: "Fix what `cua cloud test <cloud>` reports (it creates nothing)", manual: true },
      async run(ctx) {
        try {
          const chosen = await location(ctx.signal);
          if (!chosen.location) return fail(chosen.why);
          const test = await api.cloudTest(chosen.location, ctx.signal);
          const failed = test.checks.filter((c) => !c.ok);
          if (test.ok) return { status: "pass", observed: `${chosen.location}: ${test.checks.length} checks passed` };
          return fail(`${chosen.location}: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ") || "not ready"}`);
        } catch (error) {
          return fail(apiProblem(error));
        }
      },
    },
    {
      id: "cua.targets",
      description: "each requested target OS is available",
      kind: "observe",
      required: true,
      dependsOn: ["cua.cloud"],
      async run(ctx) {
        const requested = [...new Set([...(await targets(ctx.projectRoot)), "linux" as TargetOs])];
        const refused = requested.map(targetRefusal).filter((r): r is string => r !== undefined);
        if (refused.length > 0) return fail(refused.join("; "));
        try {
          const settings = await options.settings();
          const chosen = chooseLocation(settings, await cloudStatus(ctx.signal));
          const provider = (await cloudStatus(ctx.signal)).find((p) => p.name === chosen.location);
          const image = settings.image ?? DEFAULT_IMAGE;
          const kind = provider?.kinds.find((k) => k.image === image) ?? provider?.kinds.find((k) => k.image === "linux");
          if (kind && !kind.supported) return fail(`linux on ${chosen.location}: ${kind.reason ?? "not supported"}`);
          return { status: "pass", observed: `linux (${image}${kind?.machineType ? ` on ${kind.machineType}` : ""})` };
        } catch (error) {
          return fail(apiProblem(error));
        }
      },
    },
    {
      id: "cua.ttl",
      description: "sandboxes in the cloud expire on their own",
      kind: "observe",
      required: false,
      dependsOn: ["cua.cloud"],
      degrades: "a sandbox left by a crash keeps billing until the next Pi start or /gui-cleanup",
      remediation: { summary: "Set an expiry: `cua cloud connect <cloud> --ttl-hours 8`", manual: true },
      async run(ctx) {
        try {
          const chosen = await location(ctx.signal);
          const provider = (await cloudStatus(ctx.signal)).find((p) => p.name === chosen.location);
          const ttl = provider?.ttlHours;
          if (ttl === undefined) return { status: "warn", observed: "expiry unknown" };
          if (ttl === 0) return { status: "warn", observed: "sandboxes never expire (ttl 0)" };
          return { status: "pass", observed: `${ttl} h`, facts: { "cua.ttlHours": String(ttl) } };
        } catch (error) {
          return { status: "warn", observed: apiProblem(error) };
        }
      },
    },
    {
      id: "cua.rate",
      description: "an hourly price is known for the cost estimate",
      kind: "observe",
      required: false,
      dependsOn: ["cua.cloud"],
      degrades: "no cost estimate and no usageCheck cost warnings",
      remediation: { summary: "Enter your cloud's hourly price at /gui-setup cua (stored as rateUsdPerHour)", manual: true },
      async run(ctx) {
        try {
          const settings = await options.settings();
          const chosen = chooseLocation(settings, await cloudStatus(ctx.signal));
          const rate = chosen.location ? reportedRate(await cloudStatus(ctx.signal), chosen.location, settings.image ?? DEFAULT_IMAGE) : undefined;
          if (rate !== undefined) return { status: "pass", observed: `~$${rate.toFixed(2)}/h (reported by Cua)` };
          if (settings.rateUsdPerHour !== undefined) return { status: "pass", observed: `~$${settings.rateUsdPerHour.toFixed(2)}/h (entered at setup)` };
          return { status: "warn", observed: "no price reported and none entered" };
        } catch (error) {
          return { status: "warn", observed: apiProblem(error) };
        }
      },
    },
    {
      id: "cua.cost-ack",
      description: "billing and upload acknowledged at setup",
      kind: "observe",
      required: true,
      dependsOn: ["cua.cloud"],
      remediation: { summary: "Confirm at /gui-setup cua, or pass --accept-billing: sandboxes bill your cloud account and synced project files are uploaded", manual: true },
      async run(ctx) {
        const settings = await options.settings();
        if (!settings.billingAcceptedAt) return fail("not acknowledged");
        const chosen = await location(ctx.signal).catch(() => ({ location: settings.location }));
        if (settings.billingLocation && chosen.location && settings.billingLocation !== chosen.location) {
          return fail(`acknowledged for ${settings.billingLocation}, but sandboxes would run in ${chosen.location}`);
        }
        return { status: "pass", observed: `acknowledged ${settings.billingAcceptedAt}${settings.billingLocation ? ` for ${settings.billingLocation}` : ""}` };
      },
    },
  ];
}

/** Targets of the project at `projectRoot` (its resolved `targets`). */
export async function projectTargets(projectRoot: string): Promise<readonly TargetOs[]> {
  return (await loadResolvedConfig(projectRoot)).shared.targets;
}
