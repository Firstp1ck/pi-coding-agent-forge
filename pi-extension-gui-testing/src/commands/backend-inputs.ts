/**
 * Backend-specific inputs of the commands, found through capabilities (no
 * backend is named): the SSH host of the remote backends (spec §4.2a, §5.2
 * step 1) and the flags that only some backends accept.
 */
import type { Backend } from "../backend.ts";
import { hasBilling, hasImage } from "../backends/capabilities.ts";
import { hasRemoteHost, type RemoteHostCapability } from "../backends/remote/host.ts";
import type { SetupArgs } from "../config/flags.ts";
import type { BackendId, GlobalConfig, ResolvedConfig } from "../config/types.ts";

/** A remote backend that can tell whether `sudo -n` works on its host. */
export interface RemoteSudo {
  passwordlessSudo(signal?: AbortSignal): Promise<boolean>;
}

export function hasRemoteSudo(backend: Backend): backend is Backend & RemoteSudo {
  return typeof (backend as Partial<RemoteSudo>).passwordlessSudo === "function";
}

/**
 * Why a `/gui-setup` flag does not fit the chosen backend, or `undefined`.
 * Flags that replace a prompt of another backend are refused, never silently ignored.
 */
export function setupFlagProblem(id: BackendId, backend: Backend, parsed: SetupArgs): string | undefined {
  if (parsed.apiKeyEnv !== undefined) {
    return "/gui-setup: --api-key-env is no longer used: cua uses your `cua auth login` session and needs no API key (Cua Cloud API keys ended with Cua Cloud)";
  }
  const remote = hasRemoteHost(backend);
  if (parsed.host !== undefined && !remote) return `/gui-setup: --host only applies to the remote backends (remote-linux, remote-linux-docker), not ${id}`;
  if (parsed.purgeTooling && !(remote && hasImage(backend))) return `/gui-setup: --purge-tooling only applies to remote-linux-docker, not ${id}`;
  if (!hasBilling(backend)) {
    const billing = [
      parsed.acceptBilling ? "--accept-billing" : undefined,
      parsed.cloud !== undefined ? "--cloud" : undefined,
      parsed.rateUsdPerHour !== undefined ? "--rate-usd-per-hour" : undefined,
      parsed.targets !== undefined ? "--targets" : undefined,
    ].filter((f): f is string => f !== undefined);
    if (billing.length > 0) return `/gui-setup: ${billing.join(", ")} only ${billing.length === 1 ? "applies" : "apply"} to cua, not ${id}`;
  }
  if (parsed.acceptWindowsLicense) return "/gui-setup: --accept-windows-license only applies to docker-windows, which is not available yet";
  return undefined;
}

/**
 * The host a remote backend uses outside setup (doctor, cleanup, reset,
 * launch): `remote.host` (`.pi/gui.local.json`, then the global config), else
 * the host recorded when the backend was verified.
 */
export function configuredHost(id: BackendId, resolved: Pick<ResolvedConfig, "remote"> | undefined, global: Pick<GlobalConfig, "verified"> | undefined): string | undefined {
  return resolved?.remote?.host ?? global?.verified[id]?.inputs?.host;
}

/**
 * Points a remote backend at its configured host before checks, sweeps,
 * audits, image builds, or reset. Other backends are left alone.
 *
 * @returns The host in use (`undefined` when none is configured or the backend is not remote).
 * @throws Error for a configured value that is not a usable SSH destination.
 */
export function useConfiguredHost(id: BackendId, backend: Backend, resolved: Pick<ResolvedConfig, "remote"> | undefined, global: Pick<GlobalConfig, "verified"> | undefined): string | undefined {
  if (!hasRemoteHost(backend)) return undefined;
  const host = configuredHost(id, resolved, global);
  backend.useHost(host);
  return backend.remoteHost;
}

export type { RemoteHostCapability };
