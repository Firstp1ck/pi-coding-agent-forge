export type ReleaseRecord = {
  target: string;
  name: string | null;
  version: string | null;
  oldVersion?: string | null;
  status: string;
  stage?: string;
  action: string;
  detail?: string;
  logPath?: string;
  warnings?: string[];
};

/** Recover verified/processing uploads immediately; readiness is never a final outcome. */
export function parseReleaseRecords(output: string): ReleaseRecord[] {
  const records = new Map<string, ReleaseRecord>();
  for (const line of output.split(/\r?\n/)) {
    const progress = line.startsWith("RELEASE_NPM_PROGRESS ");
    if (!progress && !line.startsWith("RELEASE_NPM_EVENT ")) continue;
    try {
      const value = JSON.parse(line.slice(progress ? "RELEASE_NPM_PROGRESS ".length : "RELEASE_NPM_EVENT ".length));
      if (progress && (!["published", "processing"].includes(value?.status) || value?.stage !== "verify")) continue;
      if (!value || typeof value.target !== "string" || !value.target || typeof value.status !== "string" || typeof value.action !== "string") continue;
      if (value.name !== null && typeof value.name !== "string") continue;
      if (value.version !== null && typeof value.version !== "string") continue;
      records.set(value.target, { ...value, status: value.originalStatus ?? value.status });
    } catch {
      // A killed process can leave an incomplete final line. Earlier records survive.
    }
  }
  return [...records.values()];
}

export function isReleaseFailure(record: ReleaseRecord): boolean {
  return ["failed", "blocked", "cancelled"].includes(record.status);
}

export function structuredReleaseSummary(records: ReleaseRecord[], heading: string): string {
  const label = (record: ReleaseRecord) => `${record.name ?? record.target}${record.version ? `@${record.version}` : ""}`;
  const list = (status: string[]) => records.filter(record => status.includes(record.status));
  const groups: Array<[string, ReleaseRecord[]]> = [
    ["Ready", list(["ready"])], ["Published", list(["published"])],
    ["Processing in registry", list(["processing"])],
    ["Unchanged or excluded", list(["unchanged", "skipped"])], ["Failed, blocked or cancelled", records.filter(isReleaseFailure)],
  ];
  return [heading, ...groups.flatMap(([title, items]) => [
    `${title}: ${items.length}`,
    ...items.filter(record => !["unchanged", "skipped"].includes(record.status)).map(record => `  ${label(record)}: ${record.detail ?? record.action}${isReleaseFailure(record) && record.logPath ? ` | log: ${record.logPath}` : ""}`),
  ]), ...records.flatMap(record => (record.warnings ?? []).map(warning => `  Warning for ${label(record)}: ${warning}`))].join("\n");
}
