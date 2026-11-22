// Test client for the Windows helper core. Starts run-fake-helper.ps1 with
// PowerShell 7 (the real C# core with the scripted fake platform instead of
// Win32) and speaks protocol version 2 over its stdio, exactly like the
// TypeScript client: token framing, ready line, request ids, log events.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { validateResult } from "../../src/backends/response.ts";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const READY_PREFIX = "PI-GUI-TESTING-READY";
export const LOCAL_TEMP = "C:\\Users\\tester\\AppData\\Local\\Temp";


/**
 * Bound for waits that include the helper's Add-Type compile (ready line, or an exit
 * before ready). pwsh compiles in a few seconds alone, but tens of seconds on a loaded
 * host (two suites in parallel); these tests check protocol behaviour, not startup time.
 */
export const COMPILE_WAIT_MS = 60_000;

/** PowerShell 7 for the tests: PI_GUI_PWSH, pwsh on PATH, or a copy under ~/.local/share/pi-tools. */
export function findPwsh() {
  if (process.env.PI_GUI_PWSH) return existsSync(process.env.PI_GUI_PWSH) ? process.env.PI_GUI_PWSH : null;
  const which = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const tools = join(homedir(), ".local", "share", "pi-tools");
  if (existsSync(tools)) {
    for (const entry of readdirSync(tools).sort().reverse()) {
      const candidate = join(tools, entry, "pwsh");
      if (entry.startsWith("powershell-") && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function baseEnv(extra = {}) {
  const token = randomBytes(16).toString("hex");
  return {
    token,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      PI_GUI_TESTING_TOKEN: token,
      PI_GUI_WORKSPACE: "C:\\work\\project",
      PI_GUI_RUNTIME_DIR: `${LOCAL_TEMP}\\pi-gui-testing-test1`,
      FAKE_LOCAL_TEMP: LOCAL_TEMP,
      ...extra,
    },
  };
}

export class HelperError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class Helper {
  constructor(child, token) {
    this.child = child;
    this.token = token;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.responses = [];
    this.stderr = "";
    this.diagnostics = [];
    this.ready = false;
    this.readyAt = 0;
    let buffer = "";
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        if (!this.ready) this.rejectReady(new Error(`helper exited (${code}) before ready; stderr:\n${this.stderr}`));
        for (const { reject } of this.pending.values()) reject(new Error(`helper exited (${code}) with requests pending`));
        this.pending.clear();
        resolve(code);
      });
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  static start({ env, token, stdinEnv, args = [], script = "run-fake-helper.ps1" }) {
    const pwsh = findPwsh();
    const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(HERE, script), ...args];
    if (stdinEnv) argv.push("-StdinEnv", stdinEnv);
    const child = spawn(pwsh, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    return new Helper(child, token);
  }

  onLine(line) {
    if (!this.ready) {
      if (line === `${READY_PREFIX} ${this.token}`) {
        this.ready = true;
        this.readyAt = Date.now();
        this.resolveReady();
      } else {
        this.diagnostics.push(line);
      }
      return;
    }
    const prefix = `${this.token} `;
    if (!line.startsWith(prefix)) {
      this.diagnostics.push(line);
      return;
    }
    const message = JSON.parse(line.slice(prefix.length));
    if (message.event !== undefined) {
      this.events.push(message);
      return;
    }
    this.responses.push(message);
    const waiter = this.pending.get(message.id);
    if (waiter) {
      this.pending.delete(message.id);
      waiter.resolve(message);
    }
  }

  /** Resolves once stderr matches `pattern`: stderr arrives independently of the stdout responses. */
  async expectStderr(pattern, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(this.stderr)) {
      if (Date.now() >= deadline) throw new Error(`stderr did not match ${pattern} within ${timeoutMs} ms:\n${this.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async waitReady(timeoutMs = COMPILE_WAIT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no ready line within ${timeoutMs} ms; stderr:\n${this.stderr}`)), timeoutMs);
    });
    try {
      await Promise.race([this.readyPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  sendRaw(line) {
    this.child.stdin.write(`${line}\n`);
  }

  /** Sends a request and resolves with the raw response envelope. */
  send(method, params = {}, id = this.nextId++) {
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.sendRaw(`${this.token} ${JSON.stringify({ id, method, params })}`);
    return { id, promise };
  }

  /** Sends a request; returns the result validated by src/backends/response.ts, or throws HelperError. */
  async call(method, params = {}) {
    const response = await this.send(method, params).promise;
    return checkResponse(method, response);
  }

  closeStdin() {
    this.child.stdin.end();
  }

  async waitExit(timeoutMs = 15000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`helper did not exit within ${timeoutMs} ms; stderr:\n${this.stderr}`)), timeoutMs);
    });
    try {
      return await Promise.race([this.exitPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  kill() {
    if (this.exitCode === undefined) this.child.kill("SIGKILL");
  }
}

/** Validates an envelope like the client: ok results through validateResult, errors by shape. */
export function checkResponse(method, response) {
  if (typeof response.id !== "number") throw new Error(`response without id: ${JSON.stringify(response)}`);
  if (response.ok === true) return validateResult(method, response.result);
  if (response.ok !== false || typeof response.error?.code !== "string" || typeof response.error?.message !== "string")
    throw new Error(`malformed error envelope: ${JSON.stringify(response)}`);
  throw new HelperError(response.error.code, response.error.message);
}

/** Decodes an 8-bit RGB PNG (colour type 2, any of the five filters) into raw RGB pixels. */
export function decodePng(png) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2) throw new Error("expected 8-bit RGB");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`unexpected filter ${filter}`);
    raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgb: out };
}

/** The fake platform's pixel pattern: byte i = (i * 7) & 0xff. */
export function fakePattern(width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) & 0xff;
  return rgb;
}
