#!/usr/bin/env node
/*
 * Render a storyboard to MP4, stills, a contact sheet or a playable preview page.
 *
 * Needs Node 22+ (built-in WebSocket), a Chromium-family browser and ffmpeg.
 * The browser runs headless with a throwaway profile; nothing opens on screen.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadStoryboard, validateStoryboard, buildPage } from './lib/storyboard.mjs';

const USAGE = `usage: render.mjs <storyboard.json> [options]

  --out <file.mp4>       video path (default: next to the storyboard)
  --no-video             skip the video (use with --stills, --sheet or --preview)
  --stills <t,t,...>     save PNG frames at these times in seconds
  --stills-dir <dir>     where stills go (default: <storyboard dir>/stills)
  --sheet <file.png>     save a 4x3 contact sheet of evenly spaced frames
  --preview <file.html>  save a page that plays the video in a browser
  --fps <n>              override the storyboard frame rate
  --crf <n>              x264 quality, lower is better (default 18)
  --chromium <path>      browser binary (default: $CHROME_PATH, then PATH lookup)
  --force                render even when the storyboard has validation errors`;

const COMMAND_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const opts = { video: true, crf: 18 };
  const valueFlags = new Set(['--out', '--stills', '--stills-dir', '--sheet', '--preview', '--fps', '--crf', '--chromium']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-video') opts.video = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (valueFlags.has(a)) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!opts.file) opts.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.stills) {
    opts.stills = opts.stills.split(',').map((s) => Number(s.trim()));
    if (opts.stills.some((t) => !Number.isFinite(t) || t < 0)) throw new Error('--stills takes comma-separated times in seconds');
  }
  for (const key of ['fps', 'crf']) {
    if (opts[key] != null) {
      opts[key] = Number(opts[key]);
      if (!Number.isFinite(opts[key])) throw new Error(`--${key} must be a number`);
    }
  }
  if (opts.fps != null && (!Number.isInteger(opts.fps) || opts.fps < 12 || opts.fps > 60)) throw new Error('--fps must be a whole number from 12 to 60');
  if (opts.crf != null && (opts.crf < 0 || opts.crf > 51)) throw new Error('--crf must be from 0 to 51');
  return opts;
}

function which(name) {
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findChromium(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'microsoft-edge']) {
    const found = which(name);
    if (found) return found;
  }
  throw new Error('no Chromium-family browser found; install chromium or pass --chromium <path>');
}

/** Minimal Chrome DevTools Protocol client over the browser WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: ok, reject, timer, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: browser connection closed`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`cannot connect to browser at ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply within ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: ok, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, sessionId) {
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), COMMAND_TIMEOUT_MS);
      const listener = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          ok(msg.params);
        }
      };
      this.listeners.push(listener);
    });
  }

  close() { this.ws.close(); }
}

async function launchBrowser(binary, profileDir) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--force-device-scale-factor=1', '--font-render-hinting=none', '--allow-file-access-from-files',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'
  ];
  // Own process group, so cleanup can stop Chromium's helper processes too. A helper
  // that outlives the main process can recreate the profile folder after it is removed.
  const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  let spawnError = null;
  proc.once('error', (err) => { spawnError = err; });
  const exited = new Promise((ok) => proc.once('exit', (code) => ok(code)));
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + BROWSER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`cannot start browser ${binary}: ${spawnError.message}`);
    if (proc.exitCode != null) throw new Error(`browser exited with code ${proc.exitCode}:\n${stderr}`);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && path) return { proc, exited, wsUrl: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  killGroup(proc, 'SIGKILL');
  throw new Error(`browser did not start within ${BROWSER_START_TIMEOUT_MS / 1000}s:\n${stderr}`);
}

function killGroup(proc, signal) {
  try {
    if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

async function stopBrowser(browser) {
  if (!browser) return;
  if (browser.proc.exitCode != null) {
    killGroup(browser.proc, 'SIGKILL');
    return;
  }
  killGroup(browser.proc, 'SIGTERM');
  const abort = new AbortController();
  const timeout = sleep(3000, 'timeout', { signal: abort.signal }).catch(() => 'exited');
  await Promise.race([browser.exited, timeout]);
  abort.abort();
  killGroup(browser.proc, 'SIGKILL');
}

function startEncoder(out, fps, crf) {
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const done = new Promise((ok, fail) => {
    proc.once('error', (err) => fail(new Error(`cannot start ffmpeg: ${err.message}`)));
    proc.once('exit', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}:\n${stderr}`))));
  });
  // A write after ffmpeg died raises EPIPE here; `done` carries the real error.
  proc.stdin.on('error', () => {});
  return {
    async write(buf) {
      if (!proc.stdin.write(buf)) await new Promise((ok) => proc.stdin.once('drain', ok));
    },
    async finish() { proc.stdin.end(); await done; },
    abort() { proc.kill('SIGKILL'); },
    done
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || !opts.file) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  const loaded = loadStoryboard(opts.file);
  const { errors, warnings, total } = validateStoryboard(loaded.sb, { scenes: loaded.scenes, dir: loaded.dir });
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    if (!opts.force) process.exit(1);
  }

  const name = basename(opts.file).replace(/\.json$/i, '');
  if (opts.preview) {
    const previewPath = resolve(opts.preview);
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(previewPath, buildPage(loaded, { play: true }));
    console.error(`preview: ${previewPath} (loads images from ${loaded.dir})`);
  }
  if (!opts.video && !opts.stills && !opts.sheet) return;
  if (opts.video && !which('ffmpeg')) throw new Error('ffmpeg not found on PATH');

  const fps = opts.fps || loaded.sb.fps || 30;
  const width = loaded.sb.width || 1920;
  const height = loaded.sb.height || 1080;
  const work = mkdtempSync(join(tmpdir(), 'explainer-video-'));
  let browser;
  let cdp;
  let encoder;
  let partialVideo = null;
  const cleanup = async () => {
    if (encoder) {
      encoder.abort();
      if (partialVideo) rmSync(partialVideo, { force: true });
    }
    cdp?.close();
    await stopBrowser(browser);
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const pagePath = join(work, 'page.html');
    writeFileSync(pagePath, buildPage(loaded, { play: false }));
    browser = await launchBrowser(findChromium(opts.chromium), join(work, 'profile'));
    cdp = await Cdp.connect(browser.wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loadedEvent = cdp.waitFor('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url: pathToFileURL(pagePath).href });
    await loadedEvent;

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        throw new Error(`page error: ${ex.exception?.description || ex.text}`);
      }
      return r.result.value;
    };
    const startError = await evaluate('window.__EV_ERROR || null');
    if (startError) throw new Error(startError);
    const playerType = await evaluate('typeof window.__EV');
    if (playerType !== 'object') throw new Error('player did not start; check the scenes file for broken HTML or script errors');
    await evaluate('window.__EV.ready()');
    const capture = async (t) => {
      await evaluate(`window.__EV.seek(${t})`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      return Buffer.from(data, 'base64');
    };

    if (opts.stills) {
      const dir = resolve(opts.stillsDir || join(loaded.dir, 'stills'));
      mkdirSync(dir, { recursive: true });
      for (const t of opts.stills) {
        const file = join(dir, `${name}-${t.toFixed(2)}s.png`);
        writeFileSync(file, await capture(t));
        console.error(`still: ${file}`);
      }
    }

    if (opts.sheet) {
      if (!which('ffmpeg')) throw new Error('ffmpeg not found on PATH (needed for --sheet)');
      const count = 12;
      for (let i = 0; i < count; i++) {
        const t = (total * (i + 0.5)) / count;
        writeFileSync(join(work, `sheet${String(i).padStart(3, '0')}.png`), await capture(t));
      }
      const sheet = resolve(opts.sheet);
      mkdirSync(dirname(sheet), { recursive: true });
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(work, 'sheet%03d.png'),
        '-vf', 'scale=480:-1,tile=4x3:padding=6:color=0x222222', '-frames:v', '1', sheet], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`contact sheet failed: ${r.stderr}`);
      console.error(`sheet: ${sheet}`);
    }

    if (opts.video) {
      const out = resolve(opts.out || join(loaded.dir, `${name}.mp4`));
      mkdirSync(dirname(out), { recursive: true });
      encoder = startEncoder(out, fps, opts.crf);
      partialVideo = out;
      const frames = Math.round(total * fps);
      const started = Date.now();
      for (let i = 0; i < frames; i++) {
        await Promise.race([encoder.write(await capture(i / fps)), encoder.done]);
        if (i % (fps * 2) === 0 || i === frames - 1) {
          process.stderr.write(`\rframe ${i + 1}/${frames} (${Math.round((100 * (i + 1)) / frames)}%)`);
        }
      }
      await encoder.finish();
      encoder = null;
      process.stderr.write('\n');
      console.error(`video: ${out} (${total.toFixed(1)}s, ${frames} frames, ${fps} fps, rendered in ${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
