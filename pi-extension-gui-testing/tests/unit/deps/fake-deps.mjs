/**
 * A fake helper side of the dependency-cache protocol (protocol 2) for unit
 * tests: the "deps dir" is a Map of path → content, `exec` of a setup command
 * "installs" into it, and `depsPack` serialises it into a gzip "archive" that
 * `depsUnpack` restores after the same size and SHA-256 checks the real
 * helper makes. Usable as a direct session (`FakeDepsSession`) or as
 * `FakeHelperChild` handlers (`depsHandlers`).
 */
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { SessionError } from "../../../src/backend.ts";

export function protocolError(code, message) {
  return { error: { code, message } };
}

/**
 * Handler table over `state` (`{ deps: Map, ... }`). `options`:
 * - `install(cmd, deps)`: what a setup command puts into the deps dir;
 * - `workspaceChanged`: answer of the "setup changed the workspace" check;
 * - `reject`: make `depsUnpack` answer ARCHIVE_REJECTED;
 * - `packTooLarge`: make `depsPack` answer TOO_LARGE.
 */
export function depsHandlers(state, options = {}) {
  state.deps ??= new Map();
  state.packs ??= new Map();
  state.uploads ??= new Map();
  state.setupRuns ??= [];
  state.unpacks ??= 0;
  return {
    exec(params, child) {
      if (params.cmd.includes(".pi-gui-setup-marker-")) {
        if (params.cmd.startsWith(":")) return { exitCode: 0, elapsedMs: 1 };
        return { exitCode: options.workspaceChanged ? 1 : 0, elapsedMs: 1 };
      }
      if (params.cmd.startsWith("[ \"$(stat")) return { exitCode: 0, elapsedMs: 1 };
      state.setupRuns.push(params.cmd);
      child?.log?.("setup", "stdout", `ran ${params.cmd}\n`);
      (options.install ?? ((cmd, deps) => deps.set(`installed/${cmd.replace(/\W+/g, "_")}`, `by ${cmd}`)))(params.cmd, state.deps);
      return { exitCode: options.setupExit ?? 0, elapsedMs: 1 };
    },
    depsPack(params) {
      if (options.packTooLarge) return protocolError("TOO_LARGE", "the deps archive exceeds the bound");
      const archive = gzipSync(JSON.stringify([...state.deps.entries()]));
      if (archive.length > params.maxBytes) return protocolError("TOO_LARGE", "the deps archive exceeds the bound");
      const transfer = randomBytes(8).toString("hex");
      state.packs.set(transfer, archive);
      return { transfer, size: archive.length, sha256: createHash("sha256").update(archive).digest("hex"), entries: state.deps.size, skipped: 1 };
    },
    depsRead(params) {
      const archive = state.packs.get(params.transfer);
      if (!archive) return protocolError("NOT_FOUND", "unknown deps transfer");
      const data = archive.subarray(params.offset, params.offset + params.length);
      return { data_base64: data.toString("base64"), eof: params.offset + data.length >= archive.length };
    },
    depsReceive(params) {
      const transfer = randomBytes(8).toString("hex");
      state.uploads.set(transfer, { size: params.size, sha256: params.sha256, chunks: [] });
      return { transfer };
    },
    depsWrite(params) {
      const upload = state.uploads.get(params.transfer);
      if (!upload) return protocolError("NOT_FOUND", "unknown deps transfer");
      upload.chunks.push(Buffer.from(params.data_base64, "base64"));
      return { received: upload.chunks.reduce((n, c) => n + c.length, 0) };
    },
    depsUnpack(params) {
      const upload = state.uploads.get(params.transfer);
      if (!upload) return protocolError("NOT_FOUND", "unknown deps transfer");
      state.uploads.delete(params.transfer);
      const archive = Buffer.concat(upload.chunks);
      state.unpacks++;
      if (options.reject || archive.length !== upload.size || createHash("sha256").update(archive).digest("hex") !== upload.sha256) {
        state.deps.clear();
        return protocolError("ARCHIVE_REJECTED", "dependency archive rejected: member x is a hardlink; the deps dir was left empty");
      }
      let entries;
      try {
        entries = JSON.parse(gunzipSync(archive).toString("utf8"));
      } catch {
        state.deps.clear();
        return protocolError("ARCHIVE_REJECTED", "dependency archive rejected: not a gzip-compressed tar archive; the deps dir was left empty");
      }
      state.deps = new Map(entries);
      return { entries: entries.length, bytes: archive.length * 3 };
    },
    depsDiscard(params) {
      state.packs.delete(params.transfer);
      state.uploads.delete(params.transfer);
      return { ok: true };
    },
  };
}

/** A minimal session object over {@link depsHandlers}, for the flow tests. */
export class FakeDepsSession {
  constructor(state = {}, options = {}) {
    this.state = state;
    this.handlers = depsHandlers(state, options);
    this.arch = options.arch ?? "x86_64";
    this.platform = options.platform ?? "Linux x86_64; glibc 2.36; debian 12; python 3.11.2";
    this.capabilities = options.capabilities ?? ["launch", "exec", "deps"];
    this.requests = [];
    this.failOn = options.failOn;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (this.failOn?.[method]) throw this.failOn[method];
    const handler = this.handlers[method];
    if (!handler) throw new SessionError("BAD_REQUEST", `unknown method ${method}`);
    const result = await handler(params);
    if (result?.error) throw new SessionError(result.error.code, result.error.message);
    return result;
  }
}
