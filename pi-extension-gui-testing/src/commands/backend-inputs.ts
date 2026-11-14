/**
 * Backend-specific inputs of the commands, found through capabilities (no
 * backend is named): the SSH host of the remote backends (spec §4.2a, §5.2
 * step 1) and the flags that only some backends accept.
 */
import type { Backend } from "../backend.ts";
import { hasBilling, hasImage, hasLicense, hasVmSettings } from "../backends/capabilities.ts";
import { bindHost, hasRemoteHost, type RemoteHostCapability } from "../backends/remote/host.ts";
import type { VmSettings } from "../backends/capabilities.ts";
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
    // Only cua ever took an API key; for every other backend it is simply not one of its options.
    return hasBilling(backend)
      ? "/gui-setup: --api-key-env is no longer used: cua uses your `cua auth login` session and needs no API key (Cua Cloud API keys ended with Cua Cloud)"
      : `/gui-setup: --api-key-env is not an option of ${id}`;
  }
  const remote = hasRemoteHost(backend);
  if (parsed.host !== undefined && !remote) return `/gui-setup: --host only applies to the remote backends (remote-linux, remote-linux-docker), not ${id}`;
  if (parsed.purgeTooling && !(remote && hasImage(backend))) return `/gui-setup: --purge-tooling only applies to remote-linux-docker, not ${id}`;
  if (!hasBilling(backend)) {
    const billing = [
      parsed.acceptBilling ? "--accept-billing" : undefined,
      parsed.cloud !== undefined ? "--cloud" : undefined,
      parsed.rateUsdPerHour !== undefined ? "--rate-usd-per-hour" : undefined,
      parsed.image !== undefined ? "--image" : undefined,
      parsed.windowsImage !== undefined ? "--windows-image" : undefined,
      parsed.windowsRateUsdPerHour !== undefined ? "--windows-rate-usd-per-hour" : undefined,
      parsed.targets !== undefined ? "--targets" : undefined,
    ].filter((f): f is string => f !== undefined);
    if (billing.length > 0) return `/gui-setup: ${billing.join(", ")} only ${billing.length === 1 ? "applies" : "apply"} to cua, not ${id}`;
  }
  if (parsed.acceptWindowsLicense && !hasLicense(backend)) return `/gui-setup: --accept-windows-license only applies to docker-windows, not ${id}`;
  if (!hasVmSettings(backend)) {
    const vm = vmFlags(parsed);
    if (vm.length > 0) return `/gui-setup: ${vm.join(", ")} only ${vm.length === 1 ? "applies" : "apply"} to docker-windows, not ${id}`;
  }
  return undefined;
}

/** The VM flags given (`--windows-version`, `--vm-ram-gb`, `--vm-cpus`, `--vm-disk-gb`). */
function vmFlags(parsed: SetupArgs): string[] {
  return [
    parsed.windowsVersion !== undefined ? "--windows-version" : undefined,
    parsed.vmRamGb !== undefined ? "--vm-ram-gb" : undefined,
    parsed.vmCpus !== undefined ? "--vm-cpus" : undefined,
    parsed.vmDiskGb !== undefined ? "--vm-disk-gb" : undefined,
  ].filter((f): f is string => f !== undefined);
}

/** The VM settings the setup flags choose (empty when none is given). */
export function vmSettingsOf(parsed: SetupArgs): Partial<VmSettings> {
  return {
    ...(parsed.windowsVersion !== undefined ? { version: parsed.windowsVersion } : {}),
    ...(parsed.vmRamGb !== undefined ? { ramGb: parsed.vmRamGb } : {}),
    ...(parsed.vmCpus !== undefined ? { cpuCores: parsed.vmCpus } : {}),
    ...(parsed.vmDiskGb !== undefined ? { diskGb: parsed.vmDiskGb } : {}),
  };
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
 * A remote backend bound to its configured host for checks, sweeps, audits,
 * image builds, or reset; other backends unchanged. The shared backend is
 * never re-pointed, so a concurrent operation keeps its own host.
 *
 * @throws Error for a configured value that is not a usable SSH destination.
 */
export function configuredView<B extends Backend>(id: BackendId, backend: B, resolved: Pick<ResolvedConfig, "remote"> | undefined, global: Pick<GlobalConfig, "verified"> | undefined): B {
  return hasRemoteHost(backend) ? bindHost(backend, configuredHost(id, resolved, global)) : backend;
}

export type { RemoteHostCapability };
