import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SafetyGuardCategory } from "./config.mjs";
import { globalOperationAllowKey, isKnownBashRuleId, isKnownOperationRuleId, operationAllowKey, operationRuleAllowKey, ruleAllowKey } from "./approvals.ts";

export type AllowEntry = {
  key: string;
  matchType?: "exact" | "rule" | "operation" | "operation-rule" | "operation-global";
  ruleId?: string;
  argv?: string[];
  kind: "bash" | "write" | "edit";
  value: string;
  cwd: string;
  label: string;
  category?: SafetyGuardCategory;
  createdAt: string;
};
export type AllowStore = { version: 1; entries: AllowEntry[] };
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const emptyStore = (): AllowStore => ({ version: 1, entries: [] });
export const normalizeCwd = (cwd: string) => path.resolve(cwd || process.cwd());
export const allowKey = (kind: AllowEntry["kind"], value: string, cwd: string) => `${kind}:${normalizeCwd(cwd)}:${value}`;
export const projectApprovalFile = (cwd: string) => path.join(normalizeCwd(cwd), CONFIG_DIR_NAME, "safety-guard-allow.json");
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const merge = (...groups: AllowEntry[][]) => [...new Map(groups.flat().map((entry) => [entry.key, entry])).values()];

export function validAllowEntry(value: unknown): value is AllowEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as AllowEntry;
  if (typeof entry.key !== "string" || !["bash", "write", "edit"].includes(entry.kind)
    || typeof entry.value !== "string" || typeof entry.cwd !== "string" || typeof entry.label !== "string"
    || typeof entry.createdAt !== "string") return false;
  if (entry.matchType === "operation" || entry.matchType === "operation-global") {
    return entry.kind === "bash" && entry.ruleId === undefined && Array.isArray(entry.argv)
      && entry.argv.length > 0 && entry.argv.every((arg) => typeof arg === "string")
      && (entry.matchType === "operation-global"
        ? entry.cwd === "" && entry.key === globalOperationAllowKey(entry.argv)
        : entry.key === operationAllowKey(entry.argv, entry.cwd));
  }
  if (entry.argv !== undefined) return false;
  if (entry.matchType === "operation-rule") return entry.kind === "bash" && isKnownOperationRuleId(entry.ruleId)
    && entry.key === operationRuleAllowKey(entry.ruleId, entry.cwd);
  if (entry.matchType === "rule") return entry.kind === "bash" && isKnownBashRuleId(entry.ruleId)
    && entry.key === ruleAllowKey(entry.ruleId, entry.cwd);
  return (entry.matchType === undefined || entry.matchType === "exact") && entry.ruleId === undefined
    && entry.key === allowKey(entry.kind, entry.value, entry.cwd);
}

function readOptional(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Safety Guard requires a regular state file: ${file}`);
    if (stat.size > MAX_STORE_BYTES) throw new Error(`Safety Guard state file exceeds 8 MiB: ${file}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_STORE_BYTES) throw new Error(`Safety Guard state file exceeds 8 MiB: ${file}`);
    if (!isUtf8(bytes)) throw new Error(`Safety Guard state file is not UTF-8: ${file}`);
    return bytes.toString("utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function parseStore(raw: string | undefined): AllowStore {
  if (raw === undefined) return emptyStore();
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid approval store JSON"); }
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid approval store format");
  return { version: 1, entries: value.entries.filter(validAllowEntry) };
}
function rejectSymlink(file: string): void {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Safety Guard refuses a symlink: ${file}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function atomicWrite(file: string, raw: string): void {
  if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error(`Safety Guard state file exceeds 8 MiB: ${file}`);
  rejectSymlink(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, raw, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

type LocalState = { raw?: string; entries: AllowEntry[]; verified: boolean; issue?: string };

export class ApprovalPersistence {
  readonly globalFile: string;
  readonly receiptFile: string;
  readonly lockFile: string;

  constructor(globalFile: string) {
    this.globalFile = path.resolve(globalFile);
    this.receiptFile = `${this.globalFile}.receipts.json`;
    this.lockFile = `${this.globalFile}.lock`;
  }

  private global(): { raw?: string; store: AllowStore } {
    rejectSymlink(this.globalFile);
    const raw = readOptional(this.globalFile);
    return { raw, store: parseStore(raw) };
  }

  private receipts(): Record<string, string> {
    rejectSymlink(this.receiptFile);
    const raw = readOptional(this.receiptFile);
    if (raw === undefined) return {};
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error("Invalid approval verification JSON"); }
    if (!value || value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
      throw new Error("Invalid Safety Guard approval verification records");
    }
    const receipts: Record<string, string> = {};
    for (const [file, hash] of Object.entries(value.files)) {
      if (path.isAbsolute(file) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) receipts[file] = hash;
    }
    return receipts;
  }

  private local(cwd: string): LocalState {
    const file = projectApprovalFile(cwd);
    try {
      rejectSymlink(path.dirname(file));
      rejectSymlink(file);
      const raw = readOptional(file);
      if (raw === undefined) return { entries: [], verified: true };
      if (this.receipts()[file] !== digest(raw)) return { raw, entries: [], verified: false, issue: `Unverified project approvals ignored: ${file}` };
      const entries = parseStore(raw).entries.filter((entry) => entry.matchType !== "operation-global" && entry.cwd === normalizeCwd(cwd));
      return { raw, entries, verified: true };
    } catch (error) {
      return { entries: [], verified: false, issue: `Cannot verify project approvals at ${file}: ${String(error)}` };
    }
  }

  private locked<T>(action: () => T): T {
    fs.mkdirSync(path.dirname(this.globalFile), { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = fs.openSync(this.lockFile, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Safety Guard approval store is busy. Retry; inspect ${this.lockFile} if it persists.`);
      throw error;
    }
    try { return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(this.lockFile); }
  }

  private saveLocal(cwd: string, entries: AllowEntry[]): void {
    const file = projectApprovalFile(cwd);
    const previous = this.local(cwd);
    if (!previous.verified) throw new Error(previous.issue);
    rejectSymlink(path.dirname(file));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const ignoreFile = path.join(path.dirname(file), ".gitignore");
    rejectSymlink(ignoreFile);
    const ignore = readOptional(ignoreFile) ?? "";
    if (!ignore.split(/\r?\n/).includes("/safety-guard-allow.json")) {
      atomicWrite(ignoreFile, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}/safety-guard-allow.json\n`);
    }
    const receipts = this.receipts();
    const raw = serialize({ version: 1, entries });
    atomicWrite(file, raw);
    try { atomicWrite(this.receiptFile, serialize({ version: 1, files: { ...receipts, [file]: digest(raw) } })); }
    catch (error) {
      // A failed receipt must not grant new permissions or silently replace verified prior grants.
      if (readOptional(file) === raw) {
        if (previous.raw === undefined) fs.unlinkSync(file);
        else atomicWrite(file, previous.raw);
      }
      throw error;
    }
  }

  private migrate(cwd: string): void {
    this.locked(() => {
      const { raw, store } = this.global();
      const legacy = store.entries.filter((entry) => entry.matchType !== "operation-global" && entry.cwd === cwd);
      if (!legacy.length) return;
      const local = this.local(cwd);
      if (!local.verified) throw new Error(local.issue);
      // Each migration preserves its own input snapshot; backups are never automatically reloaded.
      const backup = `${this.globalFile}.legacy-${randomUUID()}.bak`;
      atomicWrite(backup, raw!);
      this.saveLocal(cwd, merge(legacy, local.entries));
      if (!this.local(cwd).verified) throw new Error("Migrated approval file could not be verified");
      atomicWrite(this.globalFile, serialize({ version: 1, entries: store.entries.filter((entry) => !legacy.includes(entry)) }));
    });
  }

  load(cwd: string): { entries: AllowEntry[]; issues: string[] } {
    cwd = normalizeCwd(cwd);
    const issues: string[] = [];
    try {
      let global = this.global().store.entries;
      if (global.some((entry) => entry.matchType !== "operation-global" && entry.cwd === cwd)) {
        try { this.migrate(cwd); global = this.global().store.entries; }
        catch (error) { issues.push(`Approval migration not completed; legacy records retained: ${String(error)}`); }
      }
      const local = this.local(cwd);
      if (local.issue) issues.push(local.issue);
      return { entries: merge(global.filter((entry) => entry.matchType === "operation-global" || entry.cwd === cwd), local.entries), issues };
    } catch (error) {
      return { entries: [], issues: [`Cannot read Safety Guard approvals: ${String(error)}`] };
    }
  }

  save(entries: AllowEntry[], cwd: string): void {
    cwd = normalizeCwd(cwd);
    if (!entries.length || !entries.every(validAllowEntry)) throw new Error("Invalid approval records");
    const global = entries.every((entry) => entry.matchType === "operation-global");
    if (!global && entries.some((entry) => entry.matchType === "operation-global" || entry.cwd !== cwd)) throw new Error("Approval scope mismatch");
    this.locked(() => {
      const store = this.global().store;
      if (global) atomicWrite(this.globalFile, serialize({ version: 1, entries: merge(store.entries, entries) }));
      else {
        const local = this.local(cwd);
        if (!local.verified) throw new Error(local.issue);
        this.saveLocal(cwd, merge(local.entries, entries));
      }
    });
  }

  clear(cwd: string): void {
    cwd = normalizeCwd(cwd);
    this.locked(() => {
      const store = this.global().store;
      const local = this.local(cwd);
      if (local.raw !== undefined && local.verified) this.saveLocal(cwd, []);
      else {
        const receipts = this.receipts();
        delete receipts[projectApprovalFile(cwd)];
        if (fs.existsSync(this.receiptFile)) atomicWrite(this.receiptFile, serialize({ version: 1, files: receipts }));
      }
      atomicWrite(this.globalFile, serialize({ version: 1, entries: store.entries.filter((entry) => entry.matchType !== "operation-global" && entry.cwd !== cwd) }));
    });
  }
}
