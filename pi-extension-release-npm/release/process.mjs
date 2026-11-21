import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const launcher = path.join(os.homedir(), '.local/bin/t3-build');

export function clientCommand(client, args, { platform = process.platform, env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  if (platform !== 'win32' || client !== 'npm') return { executable: client, args };
  const directories = [path.win32.dirname(execPath), ...(env.PATH ?? env.Path ?? '').split(';')];
  const inherited = env.npm_execpath && /^npm-cli\.[cm]?js$/i.test(path.win32.basename(env.npm_execpath)) ? env.npm_execpath : undefined;
  const candidates = [inherited, ...directories.map(directory => path.win32.join(directory, 'node_modules/npm/bin/npm-cli.js'))];
  const cli = candidates.find(file => file && /\.[cm]?js$/i.test(file) && exists(file));
  if (!cli) throw new Error('Cannot locate npm-cli.js on Windows; repair the Node.js/npm installation');
  return { executable: execPath, args: [cli, ...args] };
}

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'CommandError';
    Object.assign(this, result);
  }
}

export function command(client, args, { cwd, logPath, signal, timeout = 120_000, extraEnv = {} }) {
  if (signal?.aborted) return Promise.reject(new CommandError('Release cancelled', { cancelled: true }));
  return new Promise((resolve, reject) => {
    const guarded = existsSync(launcher);
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    log.write(`$ ${client} ${args.map(value => JSON.stringify(value)).join(' ')}\n`);
    let invocation;
    try { invocation = clientCommand(client, args); }
    catch (error) { log.end(); reject(error); return; }
    const child = spawn(guarded ? launcher : invocation.executable, guarded ? [invocation.executable, ...invocation.args] : invocation.args, {
      cwd, env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fetch_retries: '0', ...extraEnv },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, cancelled = false, spawnError, logError;
    let killTimer;
    const kill = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* The process may have exited before its close event. */ }
      killTimer ??= setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* The process group has already settled. */ }
      }, 500);
    };
    const abort = () => { cancelled = true; kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    log.on('error', error => { logError = error; kill(); });
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', data => {
        log.write(data);
        if (key === 'stdout') stdout += data.toString();
        else stderr += data.toString();
        if (stdout.length + stderr.length > 4 * 1024 * 1024) {
          spawnError = new Error('Command output exceeded 4 MiB');
          stdout = stdout.slice(0, 2 * 1024 * 1024);
          stderr = stderr.slice(0, 2 * 1024 * 1024);
          kill();
        }
      });
    }
    child.on('error', error => { spawnError = error; });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if ((cancelled || timedOut || spawnError || logError) && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Settle descendants which closed their output before their parent. */ }
      }
      signal?.removeEventListener('abort', abort);
      log.end(() => {
        const result = { code, stdout, stderr, timedOut, cancelled };
        if (code === 0 && !spawnError && !logError && !timedOut && !cancelled) resolve(result);
        else {
          let category = spawnError?.code ?? logError?.code ?? `exit ${code}`;
          try {
            const errorCode = jsonOutput(stdout).error?.code;
            if (typeof errorCode === 'string' && /^[A-Z0-9_-]{1,40}$/.test(errorCode)) category = errorCode;
          } catch { /* Raw diagnostics belong only in the private package log. */ }
          reject(new CommandError(cancelled ? 'Release cancelled' : timedOut ? `${client} timed out; see package log` :
            `${client} ${args[0]} failed (${category}); see package log`, result));
        }
      });
    });
  });
}

export function missing(error, { packageLookup = false } = {}) {
  // A registry transport/auth failure must never be interpreted as a first release.
  if (!(error instanceof CommandError) || error.cancelled || error.timedOut) return false;
  if (packageLookup && /no match(?:ing version)? (?:found )?for version|no matching version|version not found/i.test(`${error.stdout}\n${error.stderr}`)) return false;
  try {
    const data = JSON.parse(error.stdout);
    if (data?.error?.code) return data.error.code === 'E404';
  } catch { /* npm may print its structured error on stderr. */ }
  return /(?:"code"\s*:\s*"E404"|\b(?:npm (?:ERR!|error) code) E404\b)/.test(error.stderr);
}

export function jsonOutput(output) {
  const text = output.trim();
  try { return JSON.parse(text); } catch { /* Lifecycle scripts can print before npm's JSON. */ }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[' && text[i] !== '{') continue;
    try { return JSON.parse(text.slice(i)); } catch { /* Continue to the final JSON report. */ }
  }
  throw new Error('Command did not return valid JSON');
}
