/**
 * The Windows helper's session record, `<runtime dir>\session.json`
 * (docs/protocol.md "Session record"). The client reads it to audit and sweep
 * after a crash. It is untrusted input: anything that does not match the
 * helper's own formats exactly is rejected, names must carry the record's
 * session tag, and lists are bounded, so a forged record can never point the
 * client at another program's job, desktop, or process.
 */
import { win32 } from "node:path";
import { samePath } from "./paths.ts";

export const SESSION_RECORD_FILE = "session.json";
/** Largest record the client reads. */
export const MAX_SESSION_RECORD_BYTES = 1024 * 1024;
/** Most processes and jobs the client inspects per record (the newest ones). */
export const MAX_RECORD_ENTRIES = 128;

/** A process as the helper identifies it: PID plus creation time (FILETIME, decimal). */
export interface WinProcessId {
  pid: number;
  created: string;
}

export interface WinSessionRecord {
  version: 1;
  helper: WinProcessId;
  /** 16 lower-case hex digits; every job and the private desktop name carry it. */
  tag: string;
  mode: "local" | "guest";
  windowStation: string;
  desktop: string;
  privateDesktop: boolean;
  jobs: string[];
  processes: WinProcessId[];
  tmpDir: string;
  status: "running" | "stopped";
  /** Jobs and processes beyond {@link MAX_RECORD_ENTRIES} that were not kept, plus processes without a creation time. */
  omitted: number;
}

export interface RecordExpectations {
  /** The runtime dir the record was read from; `tmpDir` must be its `tmp` child. */
  runtimeDir: string;
  /** Mode the session started the helper in. */
  mode?: "local" | "guest";
  /** `true`: the record must name a private desktop (always for `local`). */
  privateDesktop?: boolean;
  /**
   * The session tag the client chose and recorded before the helper started
   * (`local`: the runtime dir's 16 hex digits). A record with another tag is
   * rejected, so its job and desktop names can only be this session's.
   */
  tag?: string;
}

/** `<pid>:<created>`, the leftover id the helper uses for a process. */
export function processKey(p: WinProcessId): string {
  return `${p.pid}:${p.created}`;
}

function processId(raw: unknown): WinProcessId | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  const created = r.created;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined;
  if (typeof created !== "string" || !/^[1-9]\d{0,17}$/.test(created)) return undefined;
  return { pid, created };
}

/** Private desktop name of a session: `pi-gui-testing-<tag>-<32 hex>` (`WinDesktop.CreatePrivate`). */
export function privateDesktopPattern(tag: string): RegExp {
  return new RegExp(`^pi-gui-testing-${tag}-[0-9a-f]{32}$`);
}

/** Job name of a session: `Local\pi-gui-testing-<tag>-job-<16 hex>` (`WinPlatform.Launch`). */
export function jobNamePattern(tag: string): RegExp {
  return new RegExp(`^Local\\\\pi-gui-testing-${tag}-job-[0-9a-f]{16}$`);
}

/**
 * Parses and validates a session record.
 *
 * @returns The record, or a problem text (bounded, safe to show).
 */
export function parseSessionRecord(text: string, expect: RecordExpectations): { record: WinSessionRecord } | { problem: string } {
  if (Buffer.byteLength(text) > MAX_SESSION_RECORD_BYTES) return { problem: "is larger than 1 MiB" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problem: "is not an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { problem: "has an unknown version" };
  const helper = processId(r.helper);
  if (!helper) return { problem: "has no valid helper process" };
  if (typeof r.tag !== "string" || !/^[0-9a-f]{16}$/.test(r.tag)) return { problem: "has no valid tag" };
  const tag = r.tag;
  if (expect.tag !== undefined && tag !== expect.tag) return { problem: "has another session's tag" };
  if (r.mode !== "local" && r.mode !== "guest") return { problem: "has no valid mode" };
  if (expect.mode && r.mode !== expect.mode) return { problem: `is for mode ${r.mode}, not ${expect.mode}` };
  if (typeof r.privateDesktop !== "boolean") return { problem: "has no privateDesktop flag" };
  const wantPrivate = expect.privateDesktop ?? r.mode === "local";
  if (wantPrivate && !r.privateDesktop) return { problem: "names the interactive desktop, not a private one" };
  if (typeof r.desktop !== "string") return { problem: "has no desktop" };
  if (r.privateDesktop ? !privateDesktopPattern(tag).test(r.desktop) : r.desktop !== "Default") return { problem: "has a desktop name that is not the session's" };
  if (typeof r.windowStation !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.windowStation)) return { problem: "has no valid window station" };
  if (!Array.isArray(r.jobs) || !Array.isArray(r.processes)) return { problem: "has no job or process list" };
  const jobPattern = jobNamePattern(tag);
  const jobs: string[] = [];
  for (const job of r.jobs) {
    if (typeof job !== "string" || !jobPattern.test(job)) return { problem: "lists a job that is not the session's" };
    if (!jobs.includes(job)) jobs.push(job);
  }
  const processes: WinProcessId[] = [];
  let unidentified = 0;
  for (const entry of r.processes) {
    // The helper records creation time 0 when it could not read it: such an entry cannot be matched safely.
    if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).created === "0" && Number.isSafeInteger((entry as Record<string, unknown>).pid)) {
      unidentified++;
      continue;
    }
    const p = processId(entry);
    if (!p) return { problem: "lists a malformed process" };
    if (!processes.some((q) => q.pid === p.pid && q.created === p.created)) processes.push(p);
  }
  if (typeof r.tmpDir !== "string" || !samePath(r.tmpDir, win32.join(expect.runtimeDir, "tmp"))) return { problem: "names a temp dir outside the session's runtime dir" };
  if (r.status !== "running" && r.status !== "stopped") return { problem: "has no valid status" };
  const omitted = Math.max(0, jobs.length - MAX_RECORD_ENTRIES) + Math.max(0, processes.length - MAX_RECORD_ENTRIES) + unidentified;
  return {
    record: {
      version: 1,
      helper,
      tag,
      mode: r.mode,
      windowStation: r.windowStation,
      desktop: r.desktop,
      privateDesktop: r.privateDesktop,
      jobs: jobs.slice(-MAX_RECORD_ENTRIES),
      processes: processes.slice(-MAX_RECORD_ENTRIES),
      tmpDir: r.tmpDir,
      status: r.status,
      omitted,
    },
  };
}
