// Bounded external commands (ffmpeg, ffprobe) with cleanup on timeout and on Ctrl-C.
import { spawn } from 'node:child_process';

const running = new Set();

/**
 * Run a command to completion with a hard time limit.
 * @param {string} cmd program name or path
 * @param {string[]} args arguments, passed without a shell
 * @param {{timeoutMs: number, what: string, maxOutput?: number}} opts `what` names the operation in errors
 * @returns {Promise<{stdout: Buffer, stderr: string}>} on exit code 0
 * @throws {Error} on spawn failure, nonzero exit, or timeout (the process is killed)
 */
export function runBounded(cmd, args, { timeoutMs, what, maxOutput = 256 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(proc);
    const chunks = [];
    let size = 0;
    let stderr = '';
    let failure = null;
    const timer = setTimeout(() => {
      failure = new Error(`${what}: ${cmd} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxOutput) {
        failure = new Error(`${what}: ${cmd} wrote more than ${maxOutput} bytes`);
        proc.kill('SIGKILL');
      } else chunks.push(d);
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.once('error', (err) => {
      failure = new Error(`${what}: cannot start ${cmd}: ${err.message}`);
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      running.delete(proc);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${what}: ${cmd} exited with code ${code}${stderr ? `:\n${stderr.trim()}` : ''}`));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** Kill every command started by runBounded that is still running. Used by signal handlers. */
export function killRunning() {
  for (const proc of running) proc.kill('SIGKILL');
}
