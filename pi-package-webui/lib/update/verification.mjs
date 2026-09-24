import path from "node:path";

export function nativeUpdateOutcome(targets) {
  const changed = targets.some(({ status }) => status === "healthy");
  const failed = targets.some(({ status }) => !["healthy", "unchanged"].includes(status));
  if (changed) return failed ? "partial" : "success";
  return failed ? "failed" : "unchanged";
}

/** A spawned child is not a restored session until its own RPC state agrees. */
export function assertRestoredPiState(response, expectedSessionFile) {
  if (response?.success === false || !response?.data || response.rpcRunning === false ||
      response.data.rpcRunning === false) throw new Error("Restored Pi tab did not answer a healthy RPC state request.");
  if (expectedSessionFile && (!response.data.sessionFile ||
      path.resolve(response.data.sessionFile) !== path.resolve(expectedSessionFile))) {
    throw new Error("Restored Pi tab did not load the expected session.");
  }
}
