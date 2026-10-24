/**
 * Backend registry: the only place that maps a {@link BackendId} to code.
 * The runtime, tools, and commands look backends up here and use only the
 * `Backend` contract plus the optional capabilities of
 * `./capabilities.ts`, so adding a backend is one module and one entry below.
 */
import { dirname, join } from "node:path";
import type { BackendId, ImplementedBackendId, TargetOs } from "../config/types.ts";
import { globalConfigPath, IMPLEMENTED_BACKEND_IDS } from "../config/types.ts";
import { notAvailableMessage } from "../config/verified.ts";
import type { RuntimeBackend } from "./capabilities.ts";
import { CUA_HOST_SUPPORT, CuaBackend, type CuaBackendOptions } from "./cua.ts";
import { SandboxLedger } from "./cua/ledger.ts";
import { CuaSettingsStore } from "./cua/settings.ts";
import { DockerLinuxBackend, type DockerLinuxOptions } from "./docker-linux.ts";
import { DOCKER_LINUX_HOST_SUPPORT, type HostSupport } from "./host-support.ts";
import { LOCAL_LINUX_HOST_SUPPORT, LocalLinuxBackend, type LocalLinuxOptions } from "./local-linux.ts";
import { RemoteLinuxDockerBackend, type RemoteLinuxDockerOptions } from "./remote-linux-docker.ts";
import { RemoteLinuxBackend, type RemoteLinuxOptions } from "./remote-linux.ts";
import { REMOTE_HOST_SUPPORT } from "./remote/host.ts";

export type { RuntimeBackend } from "./capabilities.ts";
export type { HostSupport } from "./host-support.ts";

/**
 * Construction options the runtime carries for backends (tests and fixtures
 * inject runners and fakes here). Production passes none.
 */
export interface BackendOptions {
  /** Options by backend id, handed unchanged to that backend's factory as `ctx.options`. */
  backendOptions?: Partial<Record<BackendId, unknown>>;
  /** docker-linux options (kept for M1 tests; merged under `backendOptions["docker-linux"]`). */
  docker?: Partial<Omit<DockerLinuxOptions, "ownerLabel">>;
  /** docker-linux: whether a `docker` executable is on PATH (kept for M1 tests). */
  dockerOnPath?: () => Promise<boolean>;
}

/** What a factory gets from the runtime. Creating a backend must start nothing and run no command. */
export interface BackendFactoryContext {
  /** Owner label of this extension instance, for probe resources (read lazily). */
  ownerLabel: () => string;
  /** Temp root for session dirs and probes (tests); default `os.tmpdir()`. */
  tmpRoot?: string;
  /** `/proc` root for owner liveness (tests); default `/proc`. */
  procRoot?: string;
  /**
   * Directory of the runtime's global config (`<agent dir>/gui`, or the
   * directory of `RuntimeOptions.globalConfigPath`). Backends keep their own
   * state files here, so tests with a private config path never read the real agent dir.
   */
  configDir?: string;
  /** Root of the dependency cache (`RuntimeOptions.depsCacheRoot`; tests); backends default to `~/.cache/pi-extension-gui-testing/deps`. */
  depsCacheRoot?: string;
  /** `RuntimeOptions.backendOptions[id]`; the backend defines its type. */
  options: unknown;
  /** Every runtime backend option, for the M1 option names. */
  runtimeOptions: BackendOptions;
}

export type BackendFactory = (ctx: BackendFactoryContext) => RuntimeBackend;

export interface BackendEntry {
  id: BackendId;
  /** One line for the `/gui-setup` picker and argument completion. */
  description: string;
  /** Client operating systems that can run it (the `host.os` check). */
  hostSupport: HostSupport;
  /** Target operating systems of the apps it runs (`gui_launch` `target`). */
  targets: readonly TargetOs[];
  create: BackendFactory;
}

/** An ordered set of backend entries; the first one is the default when no backend is configured. */
export class BackendRegistry {
  readonly #entries: Map<BackendId, BackendEntry>;

  constructor(entries: readonly BackendEntry[]) {
    this.#entries = new Map();
    for (const entry of entries) {
      if (this.#entries.has(entry.id)) throw new Error(`backend "${entry.id}" is registered twice`);
      this.#entries.set(entry.id, entry);
    }
    if (this.#entries.size === 0) throw new Error("a backend registry needs at least one backend");
  }

  /** Registered ids in order. */
  get ids(): BackendId[] {
    return [...this.#entries.keys()];
  }

  /** The default backend: the first registered one. */
  get defaultId(): BackendId {
    return this.ids[0];
  }

  has(id: string): id is BackendId {
    return this.#entries.has(id as BackendId);
  }

  entry(id: BackendId): BackendEntry | undefined {
    return this.#entries.get(id);
  }

  entries(): BackendEntry[] {
    return [...this.#entries.values()];
  }

  /** "not available yet" text listing this registry's backends. */
  notAvailableMessage(id: string): string {
    return notAvailableMessage(id, this.ids);
  }

  /**
   * Creates the backend for `id`.
   *
   * @throws Error with the "not available yet" text for an unregistered id.
   */
  create(id: BackendId, ctx: Omit<BackendFactoryContext, "options">): RuntimeBackend {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(this.notAvailableMessage(id));
    const backend = entry.create({ ...ctx, options: ctx.runtimeOptions.backendOptions?.[id] });
    if (backend.id !== id) throw new Error(`backend factory for "${id}" returned "${backend.id}"`);
    return backend;
  }
}

/**
 * The built-in backends. The key set must equal `IMPLEMENTED_BACKEND_IDS`
 * (`src/config/types.ts`); the type annotation enforces it.
 */
const BUILT_IN: { [K in ImplementedBackendId]: Omit<BackendEntry, "id"> } = {
  "docker-linux": {
    description: "Linux apps in a local Docker container with a virtual display (rootful Docker Engine, or Docker Desktop on macOS and Windows)",
    hostSupport: DOCKER_LINUX_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) =>
      new DockerLinuxBackend({
        ownerLabel: ctx.ownerLabel,
        ...(ctx.depsCacheRoot ? { depsCacheRoot: ctx.depsCacheRoot } : {}),
        ...ctx.runtimeOptions.docker,
        ...(ctx.options as Partial<DockerLinuxOptions> | undefined),
        ...(ctx.runtimeOptions.dockerOnPath ? { dockerOnPath: ctx.runtimeOptions.dockerOnPath } : {}),
        ...(ctx.tmpRoot ? { tmpRoot: ctx.tmpRoot } : {}),
      }),
  },
  "local-linux": {
    description: "Linux apps on this machine under a private virtual display (needs Xvfb, never your desktop)",
    hostSupport: LOCAL_LINUX_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) =>
      new LocalLinuxBackend({
        ownerLabel: ctx.ownerLabel,
        ...(ctx.options as Partial<LocalLinuxOptions> | undefined),
        ...(ctx.tmpRoot ? { tmpRoot: ctx.tmpRoot } : {}),
        ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
      }),
  },
  "remote-linux": {
    description: "Linux apps on your own SSH host under a private virtual display (synced copy of the project)",
    hostSupport: REMOTE_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) =>
      new RemoteLinuxBackend({
        ownerLabel: ctx.ownerLabel,
        ...(ctx.depsCacheRoot ? { depsCacheRoot: ctx.depsCacheRoot } : {}),
        ...(ctx.options as Partial<RemoteLinuxOptions> | undefined),
        ...(ctx.tmpRoot ? { tmpRoot: ctx.tmpRoot } : {}),
        ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
      }),
  },
  "remote-linux-docker": {
    description: "Linux apps in a Docker container on your own SSH host (no local Docker needed)",
    hostSupport: REMOTE_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) =>
      new RemoteLinuxDockerBackend({
        ownerLabel: ctx.ownerLabel,
        ...(ctx.depsCacheRoot ? { depsCacheRoot: ctx.depsCacheRoot } : {}),
        ...(ctx.options as Partial<RemoteLinuxDockerOptions> | undefined),
        ...(ctx.tmpRoot ? { tmpRoot: ctx.tmpRoot } : {}),
        ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
      }),
  },
  cua: {
    description: "Linux apps in a Cua sandbox in your own cloud account (AWS, Google Cloud, Hetzner, Modal; billed by that cloud)",
    hostSupport: CUA_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) => {
      // The sandbox ledger and settings follow the runtime's config dir (not always the real agent dir).
      const configDir = ctx.configDir ?? dirname(globalConfigPath());
      return new CuaBackend({
        ownerLabel: ctx.ownerLabel,
        ledger: new SandboxLedger(join(configDir, "cua-sandboxes")),
        settings: new CuaSettingsStore(join(configDir, "cua.json")),
        ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}),
        ...(ctx.options as Partial<CuaBackendOptions> | undefined),
      });
    },
  },
};

/** The registry of this build. */
export const DEFAULT_REGISTRY = new BackendRegistry(IMPLEMENTED_BACKEND_IDS.map((id) => ({ id, ...BUILT_IN[id] })));

