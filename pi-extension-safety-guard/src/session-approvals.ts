import { validAllowEntry, type AllowEntry } from "./approval-store.ts";

export const SESSION_APPROVAL_ENTRY = "safety-guard-session-approvals";
export type SessionApprovalSource = {
  getSessionId(): string;
  getEntries(): readonly { type: string; customType?: string; data?: unknown }[];
};
type AppendEntry = (type: string, data: unknown) => void;

export class SessionApprovals {
  readonly entries = new Map<string, AllowEntry>();
  private sessionId?: string;

  ensure(source: SessionApprovalSource): void {
    if (source.getSessionId() !== this.sessionId) this.restore(source);
  }

  restore(source: SessionApprovalSource): void {
    this.sessionId = source.getSessionId();
    this.entries.clear();
    // All entries are intentional: navigating the tree must not revive a cleared grant.
    for (const entry of source.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SESSION_APPROVAL_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as { version?: unknown; sessionId?: unknown; entries?: unknown };
      if (data.sessionId !== this.sessionId) continue;
      this.entries.clear();
      if (data.version !== 1 || !Array.isArray(data.entries)) continue;
      for (const grant of data.entries) {
        if (validAllowEntry(grant) && grant.matchType !== "operation-global") this.entries.set(grant.key, grant);
      }
    }
  }

  save(grants: AllowEntry[], source: SessionApprovalSource, append: AppendEntry): void {
    this.ensure(source);
    if (!grants.every((grant) => validAllowEntry(grant) && grant.matchType !== "operation-global")) throw new Error("Invalid session approval");
    const next = new Map(this.entries);
    for (const grant of grants) next.set(grant.key, grant);
    this.commit([...next.values()], source, append);
  }

  clear(source: SessionApprovalSource, append: AppendEntry): void {
    this.ensure(source);
    this.commit([], source, append);
  }

  private commit(entries: AllowEntry[], source: SessionApprovalSource, append: AppendEntry): void {
    const sessionId = source.getSessionId();
    if (!sessionId || sessionId !== this.sessionId) throw new Error("Session changed while saving approval");
    try { append(SESSION_APPROVAL_ENTRY, { version: 1, sessionId, entries }); }
    catch (error) {
      // SessionManager can append to memory before a disk write fails. Supersede that entry.
      try { append(SESSION_APPROVAL_ENTRY, { version: 1, sessionId, entries: [...this.entries.values()] }); } catch { /* The caller reports the persistence failure. */ }
      throw error;
    }
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.key, entry);
  }
}
