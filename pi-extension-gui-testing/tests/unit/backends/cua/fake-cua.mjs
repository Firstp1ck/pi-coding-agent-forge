/**
 * In-memory Cua for unit tests: a `CuaApi` with sandboxes in a Map, scripted
 * failures, recorded calls, and helper streams from the docker fakes'
 * `FakeHelperChild` (real framing over in-memory pipes). Never runs `cua`,
 * never touches the network, never bills anything.
 */
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuaApiError } from "../../../../src/backends/cua/api.ts";
import { listTar } from "../../../../src/backends/docker/tar.ts";
import { formatOwnerLabel } from "../../../../src/owner.ts";
import { BOOT, fakeProc, fakeSpawner } from "../fakes.mjs";

export const PROVIDERS = [
  {
    name: "aws",
    connected: true,
    isDefault: true,
    credentialsFound: true,
    region: "us-west-2",
    ttlHours: 8,
    kinds: [{ image: "linux", kind: "container", supported: true, machineType: "t3.medium", usdPerHour: 0.5 }],
  },
  { name: "gcp", connected: false, isDefault: false, credentialsFound: false, kinds: [] },
];

const ok = (stdout = "") => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 });

export class FakeCuaApi {
  /**
   * @param {object} [options]
   * @param {object} [options.fail] `{ create, delete, exec, upload, cloudStatus, whoami, get, list }`: an Error, a CuaApiError code string, or a function `(…args) => Error | undefined`.
   * @param {string[]} [options.missing] Helper requirements the probe reports missing.
   * @param {object} [options.install] Result of the package install (`{ exitCode, stderr }`).
   * @param {object} [options.behaviour] FakeHelperChild behaviour.
   */
  constructor(options = {}) {
    this.options = options;
    this.sandboxes = new Map();
    this.calls = [];
    this.uploads = [];
    this.deleted = [];
    this.signedInState = options.signedIn ?? true;
    this.providers = structuredClone(options.providers ?? PROVIDERS);
    this.spawner = fakeSpawner(options.behaviour ?? {});
    this.onCreate = options.onCreate;
  }

  #fail(what, ...args) {
    const rule = this.options.fail?.[what];
    if (!rule) return;
    const error = typeof rule === "function" ? rule(...args) : rule;
    if (!error) return;
    throw typeof error === "string" ? new CuaApiError(error, `fake ${what} failed (${error})`) : error;
  }

  #record(method, ...args) {
    this.calls.push({ method, args });
  }

  methods() {
    return this.calls.map((c) => c.method);
  }

  async version() {
    this.#record("version");
    this.#fail("version");
    return this.options.version ?? "0.7.0";
  }

  async signedIn() {
    this.#record("signedIn");
    return { signedIn: this.signedInState, detail: this.signedInState ? "signed in" : "not signed in" };
  }

  async whoami() {
    this.#record("whoami");
    this.#fail("whoami");
    return { account: "ada (free)" };
  }

  async cloudStatus() {
    this.#record("cloudStatus");
    this.#fail("cloudStatus");
    return structuredClone(this.providers);
  }

  async cloudTest(location) {
    this.#record("cloudTest", location);
    this.#fail("cloudTest", location);
    return this.options.cloudTest ?? { ok: true, checks: [{ name: "credentials", ok: true, detail: "ok" }] };
  }

  async createSandbox(spec, signal) {
    this.#record("createSandbox", spec);
    await this.onCreate?.(spec, this, signal);
    if (signal?.aborted) throw new CuaApiError("CANCELLED", "the cua command was cancelled");
    this.#fail("create", spec);
    const info = { name: spec.name, location: spec.location, status: "ready", image: spec.image };
    this.sandboxes.set(`${spec.location}:${spec.name}`, info);
    return { ...info };
  }

  async getSandbox(ref) {
    this.#record("getSandbox", ref);
    this.#fail("get", ref);
    const info = this.sandboxes.get(ref);
    return info ? { ...info } : undefined;
  }

  async listSandboxes() {
    this.#record("listSandboxes");
    this.#fail("list");
    return [...this.sandboxes.values()].map((s) => ({ ...s }));
  }

  async deleteSandbox(ref) {
    this.#record("deleteSandbox", ref);
    this.#fail("delete", ref);
    const missing = !this.sandboxes.has(ref);
    this.sandboxes.delete(ref);
    this.deleted.push(ref);
    return { missing };
  }

  async exec(ref, argv, options) {
    this.#record("exec", ref, [...argv], options);
    this.#fail("exec", ref, argv);
    if (!this.sandboxes.has(ref)) throw new CuaApiError("NOT_FOUND", `no sandbox ${ref}`);
    const script = argv[0] === "sh" && argv[1] === "-c" ? argv[2] : "";
    if (script.includes("missing:")) return ok((this.options.missing ?? []).map((m) => `missing:${m}\n`).join(""));
    if (script.includes("apt-get")) {
      this.installed = [...argv.slice(4)];
      return { ...ok(), ...(this.options.install ?? {}) };
    }
    return ok();
  }

  async upload(ref, localPath, guestPath) {
    this.#record("upload", ref, localPath, guestPath);
    this.#fail("upload", ref, localPath, guestPath);
    if (!this.sandboxes.has(ref)) throw new CuaApiError("NOT_FOUND", `no sandbox ${ref}`);
    const data = await readFile(localPath);
    this.uploads.push({ ref, guestPath, localPath, entries: listTar(data) });
    return { size: data.length };
  }

  spawnHelper(ref, argv, env) {
    this.#record("spawnHelper", ref, [...argv], { ...env });
    return this.spawner.spawn(argv, { env });
  }

  forceDeleteArgv(ref) {
    return ["cua", "sandbox", "rm", ref, "--force"];
  }
}

/** A minimal helper archive (the real one is the docker build context). */
export async function tinyHelperArchive() {
  const { createTar } = await import("../../../../src/backends/docker/tar.ts");
  return createTar([{ path: "helper", type: "file", mode: 0o755, data: Buffer.from("#!/usr/bin/python3 -I\n") }]);
}

/**
 * A temp tree with a project, a session dir, a fake `/proc` where `pid` 4242
 * (start 1000) is alive, a ledger dir, and a settings file with the billing
 * acknowledgement for aws.
 */
export async function cuaEnv(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gui-cua-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const sessionDir = join(root, "session");
  const proc = join(root, "proc");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(sessionDir, { mode: 0o700 });
  await writeFile(join(project, "app.py"), "print('hi')\n");
  await writeFile(join(project, "src", "lib.py"), "x = 1\n");
  await writeFile(join(project, ".env"), "SECRET=1\n");
  fakeProc(proc, { 4242: 1000, ...(options.processes ?? {}) });
  const settingsPath = join(root, "agent", "gui", "cua.json");
  if (options.settings !== false) {
    await mkdir(join(root, "agent", "gui"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ version: 1, billingAcceptedAt: "2026-10-24T00:00:00.000Z", billingLocation: "aws", ...(options.settings ?? {}) }));
  }
  return { root, project, sessionDir, proc, ledgerDir: join(root, "agent", "gui", "cua-sandboxes"), settingsPath };
}

export const LIVE_OWNER = formatOwnerLabel({ clientId: "c0ffee", pid: 4242, processStartTime: "1000", bootId: BOOT });
export const DEAD_OWNER = formatOwnerLabel({ clientId: "dead00", pid: 999, processStartTime: "5", bootId: BOOT });
export const HOST_TAG = "abcd1234";

/**
 * Runs `fn` while the first call of `fs/promises.<method>` on a path that
 * `match` accepts fails with EIO (every module's named import sees it, through
 * `syncBuiltinESMExports`). Resolves `{ value, injected }`, or rejects with
 * `fn`'s error (with `injected` set on it).
 */
export async function withFsFailureOnce(method, match, fn, times = 1) {
  const original = fs[method];
  let injected = false;
  let left = times;
  fs[method] = async (target, ...rest) => {
    if (left > 0 && match(String(target))) {
      left--;
      injected = true;
      throw Object.assign(new Error(`EIO: injected i/o error, ${method} '${target}'`), { code: "EIO" });
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return { value: await fn(), injected };
  } catch (error) {
    throw Object.assign(error, { injected });
  } finally {
    fs[method] = original;
    syncBuiltinESMExports();
  }
}
