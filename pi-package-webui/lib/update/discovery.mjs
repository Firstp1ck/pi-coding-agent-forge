import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readSharedJob } from "./coordination.mjs";
import { inspectNativeJob } from "./native-jobs.mjs";

const TERMINAL_PHASES = new Set(["success", "partial", "failed", "unchanged"]);
const JOB_FILE = /^[a-f0-9-]{36}\.json$/i;

export function nativeJobBlocksUpdates(job) {
  return Boolean(job && !TERMINAL_PHASES.has(job.phase));
}

/** Keep fence tokens, private capsule paths and process credentials off HTTP responses. */
export function publicNativeJob(job) {
  if (!job) return null;
  const { transactionId, plan, phase, receipts = [], verifiedTargets = [], outcome = "", error = "" } = job;
  return { transactionId, plan, phase, receipts, verifiedTargets, outcome, error };
}

/** Discover launched jobs without trusting browser storage or taking over another owner. */
export async function discoverNativeJobs(stateRoot, { agentDir, ownerPackageRoot, ownerBootIdentity, maxRecords = 1024 }) {
  const result = { pi: null, webui: null };
  const directory = path.join(stateRoot, "jobs");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return result; throw error; }
  const records = entries.filter((entry) => JOB_FILE.test(entry.name));
  let launchedRecords = 0;
  const selectedTimes = { pi: 0, webui: 0 };
  for (const entry of records) {
    const info = await lstat(path.join(directory, entry.name));
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("An update record is linked or exceeds its size limit.");
    const transactionId = entry.name.slice(0, -5);
    const record = await readSharedJob(stateRoot, transactionId);
    if (record?.transactionId !== transactionId || record.plan?.schemaVersion !== 2 || !record.plan.context ||
        !["pi", "webui"].includes(record.plan.requested)) throw new Error("An update record cannot be verified; inspect the host.");
    if (record.phase === "planned" || record.plan.context.agentDir !== agentDir ||
        record.plan.context.ownerPackageRoot !== ownerPackageRoot) continue;
    if (++launchedRecords > maxRecords) throw new Error("Launched update history exceeds the discovery limit; inspect the host before starting another update.");
    const createdAt = Date.parse(record.plan.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error("An update record has no valid creation time.");
    const job = await inspectNativeJob(stateRoot, transactionId);
    if (!job) throw new Error("An update record disappeared during discovery.");
    if (ownerBootIdentity && record.plan.context.ownerBootIdentity !== ownerBootIdentity &&
        nativeJobBlocksUpdates(job) && !["launching", "running"].includes(job.phase)) {
      job.phase = "unknown";
      job.error = "The original update owner exited; command receipts remain available, but recovery needs manual verification.";
    }
    const target = record.plan.requested;
    const previous = result[target];
    const priority = Number(nativeJobBlocksUpdates(job)) - Number(nativeJobBlocksUpdates(previous));
    if (!previous || priority > 0 || priority === 0 && createdAt >= selectedTimes[target]) {
      result[target] = publicNativeJob(job);
      selectedTimes[target] = createdAt;
    }
  }
  return result;
}
