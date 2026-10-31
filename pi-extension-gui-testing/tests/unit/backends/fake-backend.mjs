/**
 * A non-Docker backend built only from the public pieces a new backend uses:
 * `Backend` + optional capabilities, a registry entry, and `HelperSession`
 * over a fake helper process. Proves the shared layer needs no code change
 * for a second backend.
 */
import { hostOsCheck } from "../../../src/checks/common.ts";
import { HelperSession } from "../../../src/transport/helper-session.ts";
import { fakeSpawner } from "./fakes.mjs";

export const FAKE_HOST_SUPPORT = { platforms: ["linux"], otherwise: "the fake backend runs on Linux only" };

/**
 * @param {object} [options]
 * @param {string} [options.id] Backend id (a real `BackendId`; default `local-linux`).
 * @param {boolean | (() => Promise<boolean>)} [options.gate] Sweep gate answer.
 * @param {Record<string, string>} [options.versions] What `currentVersions` reports.
 * @param {object} [options.behaviour] FakeHelperChild behaviour (handlers, …).
 * @param {boolean} [options.capabilities] `false` → a bare `Backend` without optional capabilities.
 */
export function fakeBackendEntry(options = {}) {
  const id = options.id ?? "local-linux";
  const calls = { created: 0, starts: [], teardowns: 0, audits: 0, orphanAudits: 0, sweeps: 0, gates: [], resets: 0, recorded: [], exitCleanup: [] };
  const spawner = fakeSpawner(options.behaviour ?? {});
  const entry = {
    id,
    description: "Fake helper on the host (test backend)",
    hostSupport: FAKE_HOST_SUPPORT,
    targets: ["linux"],
    create(ctx) {
      calls.created++;
      calls.ctx = ctx;
      const backend = {
        id,
        checks: () => [
          hostOsCheck(id, "linux", FAKE_HOST_SUPPORT),
          { id: "fake.ready", description: "fake helper is ready", kind: "observe", required: true, run: async () => ({ status: "pass", observed: "ready", facts: { "fake.version": "1" } }) },
        ],
        async startSession(start) {
          calls.starts.push(start);
          await start.recordResource("fake-process", `${start.sessionId}-helper`);
          calls.recorded.push(`${start.sessionId}-helper`);
          start.onExitCleanup?.(["true", start.sessionId]);
          calls.exitCleanup.push(start.sessionId);
          let alive = false;
          const session = new HelperSession({
            id: start.sessionId,
            backend: id,
            packageVersion: "0.1.0",
            workspacePath: "/fake/workspace",
            onLog: start.onLog,
            readyTimeoutMs: 2_000,
            heartbeatIntervalMs: 0,
            exitWaitMs: 200,
            killWaitMs: 50,
            labels: { launcher: "fake-helper", target: "the fake helper", inside: "inside the fake helper", stillRunning: "fake helper still running" },
            hooks: {
              spawn: (env) => {
                alive = true;
                return spawner.spawn(["fake-helper", start.sessionId], { env });
              },
              teardown: async () => {
                calls.teardowns++;
                alive = false;
                return [];
              },
              audit: async () => {
                calls.audits++;
                return alive ? [{ kind: "fake-process", id: `${start.sessionId}-helper` }] : [];
              },
            },
          });
          await session.start(start.signal);
          return session;
        },
        async auditOrphans() {
          calls.orphanAudits++;
          return [];
        },
        async sweepOrphans() {
          calls.sweeps++;
          return [];
        },
      };
      if (options.capabilities === false) return backend;
      return Object.assign(backend, {
        version: "0.1.0",
        async currentVersions() {
          return options.versions ?? { "fake.version": "1" };
        },
        async sweepAvailable(context) {
          calls.gates.push(context.startup);
          return typeof options.gate === "function" ? options.gate() : (options.gate ?? true);
        },
        resetSummary: "Stops its sessions and removes its fake data, verified state, and backend choice.",
        resetNote: "system packages: the fake backend installs none",
        async resetData() {
          calls.resets++;
          return { lines: ["removed the fake data"], leftovers: [] };
        },
      });
    },
  };
  return { entry, calls, spawner };
}
