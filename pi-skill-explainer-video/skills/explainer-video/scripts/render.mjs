#!/usr/bin/env node
/*
 * Render a storyboard to MP4, stills, a contact sheet or a playable preview page, and
 * check the rendered layout.
 *
 * Needs Node 22+ (built-in WebSocket), a Chromium-family browser and ffmpeg.
 * The browser runs headless with a throwaway profile; nothing opens on screen.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStoryboard, validateStoryboard, buildPage, engine } from './lib/storyboard.mjs';
import { which, findChromium, openBrowser, loadPlayer } from './lib/browser.mjs';
import { PAGE_HELPER, LIMITS, TOLERANCE, analyzeLayout, frameCount, firstFrameAt, sampleFrames, seekOrderFailures, shuffledOrder } from './lib/layout.mjs';
import { holdFrames, sheetPaths, pageCount, composeSheets } from './lib/sheet.mjs';
import { renderFingerprint, aliasErrors } from './lib/delivery.mjs';

const USAGE = `usage: render.mjs <storyboard.json> [options]

  --out <file.mp4>       video path (default: next to the storyboard)
  --no-video             skip the video (use with --stills, --sheet, --preview or --check-layout)
  --stills <t,t,...>     save PNG frames at these times in seconds
  --stills-dir <dir>     where stills go (default: <storyboard dir>/stills)
  --sheet <file.png>     save a contact sheet
  --sheet-mode <mode>    overview: 4x3 grid of evenly spaced frames (default)
                         shots: one labeled frame per step at its reading hold;
                         more than 32 steps continue in <file>-p2.png, -p3.png, ...
  --check-layout         inspect every frame before rendering: caption overflow and frame
                         edges, captions over active spotlights or avoid regions, caption
                         continuity at ordinary edits and seek-order independence.
                         Problems are listed with timestamps and the command exits 1
                         without writing stills, sheets or video
  --report <file.json>   with --check-layout, also write the findings as JSON
  --preview <file.html>  save a page that plays the video in a browser
  --fps <n>              override the storyboard frame rate
  --crf <n>              x264 quality, lower is better (default 18)
  --chromium <path>      browser binary (default: $CHROME_PATH, then PATH lookup)
  --force                render even when the storyboard has validation errors`;

const SHEET_MODES = new Set(['overview', 'shots']);
const SHOT_SAMPLES_MAX = 60;
const REPORT_LINES_MAX = 40;

function parseArgs(argv) {
  const opts = { video: true, crf: 18 };
  const valueFlags = new Set(['--out', '--stills', '--stills-dir', '--sheet', '--sheet-mode', '--report', '--preview', '--fps', '--crf', '--chromium']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-video') opts.video = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--check-layout') opts.checkLayout = true;
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
  if (opts.sheetMode != null) {
    if (!SHEET_MODES.has(opts.sheetMode)) throw new Error('--sheet-mode must be overview or shots');
    if (!opts.sheet) throw new Error('--sheet-mode needs --sheet');
  }
  opts.sheetMode ??= 'overview';
  if (opts.report && !opts.checkLayout) throw new Error('--report needs --check-layout');
  return opts;
}

function startEncoder(out, fps, crf, comment) {
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-metadata', `comment=${comment}`,
    '-movflags', '+faststart', out];
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

/** Up to `max` frames spread over every step's first, middle and last frame. */
function screenshotFrames(timeline, fps, frames) {
  const picks = new Set();
  for (const seg of timeline.steps) {
    const lo = firstFrameAt(seg.start, fps);
    const hi = Math.min(frames - 1, firstFrameAt(seg.end, fps) - 1);
    for (const k of [lo, Math.round((lo + hi) / 2), hi]) if (k >= 0 && k < frames) picks.add(k);
  }
  const all = [...picks].sort((a, b) => a - b);
  if (all.length <= SHOT_SAMPLES_MAX) return all;
  return Array.from({ length: SHOT_SAMPLES_MAX }, (_, i) => all[Math.floor((i * all.length) / SHOT_SAMPLES_MAX)]);
}

/**
 * Inspect every frame forward, reverse and shuffled, compare screenshots of sampled frames in
 * two orders, and apply the layout rules.
 * @returns {Promise<object>} report object; `failures` is empty when the layout passes
 */
async function checkLayout(session, loaded, { fps, width, height, total, file, forward }) {
  const { sb } = loaded;
  const frames = forward.length;
  const progress = (pass) => (done) => process.stderr.write(`\rlayout: ${pass} pass ${done}/${frames} frames`);
  const reverseOrder = forward.map((_, k) => frames - 1 - k);
  const reverse = await sampleFrames(session, reverseOrder, fps, progress('reverse'));
  process.stderr.write('\n');
  const jumpyOrder = shuffledOrder(frames);
  const jumpy = await sampleFrames(session, jumpyOrder, fps, progress('shuffled'));
  process.stderr.write('\n');
  const inFrameOrder = (results, order) => {
    const sigs = new Array(frames);
    results.forEach((r, j) => { sigs[order[j]] = r.sig; });
    return sigs;
  };
  const reference = forward.map((r) => r.sig);
  const failures = [
    ...seekOrderFailures(reference, inFrameOrder(reverse, reverseOrder), 'reverse', fps),
    ...seekOrderFailures(reference, inFrameOrder(jumpy, jumpyOrder), 'shuffled', fps)
  ];

  const timeline = engine.buildTimeline(sb);
  const shotFrames = screenshotFrames(timeline, fps, frames);
  const capture = async (k) => {
    await session.evaluate(`window.__EV.seek(${k / fps})`);
    return session.screenshot();
  };
  const first = new Map();
  for (const k of shotFrames) first.set(k, await capture(k));
  for (const j of shuffledOrder(shotFrames.length, 0x9e3779b9)) {
    const k = shotFrames[j];
    if (!first.get(k).equals(await capture(k))) {
      failures.push({ kind: 'seek-order', step: null, pass: 'screenshot', from: k / fps, to: k / fps, firstFrame: k, frames: 1,
        message: `at ${(k / fps).toFixed(3)}s (frame ${k}): screenshot differs when frames are seeked in shuffled order` });
    }
  }
  process.stderr.write(`layout: compared ${shotFrames.length} screenshots in two seek orders\n`);

  const analysis = analyzeLayout(sb, forward.map((r) => r.inspect), { fps, width, height });
  failures.push(...analysis.failures);
  failures.sort((a, b) => a.from - b.from || a.kind.localeCompare(b.kind));
  return {
    storyboard: resolve(file),
    ok: failures.length === 0,
    fps, width, height, total, frames,
    passes: ['forward', 'reverse', 'shuffled'],
    screenshotFrames: shotFrames.length,
    tolerance: TOLERANCE,
    failures,
    continuity: analysis.continuity,
    limits: LIMITS
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
  const sourcePaths = [resolve(opts.file), ...(loaded.sb.scenes ? [resolve(loaded.dir, loaded.sb.scenes)] : []),
    ...loaded.sb.steps.map((step) => step.image).filter(Boolean).map((path) => resolve(loaded.dir, path)),
    ...(loaded.sb.outro?.logo ? [resolve(loaded.dir, loaded.sb.outro.logo)] : [])];
  const stillDir = resolve(opts.stillsDir || join(loaded.dir, 'stills'));
  const outputPaths = [
    ...(opts.video ? [resolve(opts.out || join(loaded.dir, `${name}.mp4`))] : []),
    ...[opts.preview, opts.report].filter(Boolean).map((path) => resolve(path)),
    ...(opts.sheet ? sheetPaths(resolve(opts.sheet), opts.sheetMode === 'shots' ? pageCount(loaded.sb.steps.length) : 1) : []),
    ...(opts.stills || []).map((t) => join(stillDir, `${name}-${t.toFixed(2)}s.png`))
  ];
  const aliases = aliasErrors([
    ...sourcePaths.map((path) => ({ role: 'render source', path, output: false })),
    ...outputPaths.map((path) => ({ role: 'render output', path, output: true }))
  ]);
  if (aliases.length) throw new Error(aliases.join('\n'));
  if (opts.preview) {
    const previewPath = resolve(opts.preview);
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(previewPath, buildPage(loaded, { play: true, fps: opts.fps }));
    console.error(`preview: ${previewPath} (loads images from ${loaded.dir})`);
  }
  if (!opts.video && !opts.stills && !opts.sheet && !opts.checkLayout) return;
  const overviewSheet = opts.sheet && opts.sheetMode === 'overview';
  if ((opts.video || overviewSheet) && !which('ffmpeg')) throw new Error(`ffmpeg not found on PATH (needed for ${opts.video ? 'the video' : '--sheet'})`);

  const fps = opts.fps || loaded.sb.fps || 30;
  const width = loaded.sb.width || 1920;
  const height = loaded.sb.height || 1080;
  const frames = frameCount(total, fps);
  const work = mkdtempSync(join(tmpdir(), 'explainer-video-'));
  let session;
  let encoder;
  let partialVideo = null;
  const cleanup = async () => {
    if (encoder) encoder.abort();
    if (partialVideo) rmSync(partialVideo, { force: true });
    await session?.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const pagePath = join(work, 'page.html');
    writeFileSync(pagePath, buildPage(loaded, { play: false, fps }));
    session = await openBrowser(findChromium(opts.chromium), join(work, 'profile'));
    await loadPlayer(session, pathToFileURL(pagePath).href, width, height);
    const capture = async (t) => {
      await session.evaluate(`window.__EV.seek(${t})`);
      return session.screenshot();
    };

    const shots = opts.sheet && opts.sheetMode === 'shots';
    let forward = null;
    if (opts.checkLayout || shots) {
      await session.evaluate(PAGE_HELPER);
      forward = await sampleFrames(session, Array.from({ length: frames }, (_, k) => k), fps,
        (done) => process.stderr.write(`\rlayout: forward pass ${done}/${frames} frames`));
      process.stderr.write('\n');
    }

    if (opts.checkLayout) {
      const report = await checkLayout(session, loaded, { fps, width, height, total, file: opts.file, forward });
      if (opts.report) {
        const reportPath = resolve(opts.report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`report: ${reportPath}`);
      }
      if (!report.ok) {
        for (const f of report.failures.slice(0, REPORT_LINES_MAX)) console.error(`layout: ${f.message}`);
        if (report.failures.length > REPORT_LINES_MAX) console.error(`layout: ... and ${report.failures.length - REPORT_LINES_MAX} more${opts.report ? ' in the report' : ''}`);
        throw new Error(`layout check failed: ${report.failures.length} problem(s) in ${frames} frames`);
      }
      console.error(`layout: ok, ${frames} frames, ${report.continuity.length} edit(s) checked for caption continuity`);
    }

    if (opts.stills) {
      const dir = resolve(opts.stillsDir || join(loaded.dir, 'stills'));
      mkdirSync(dir, { recursive: true });
      for (const t of opts.stills) {
        const file = join(dir, `${name}-${t.toFixed(2)}s.png`);
        writeFileSync(file, await capture(t));
        console.error(`still: ${file}`);
      }
    }

    let shotTiles = null;
    if (opts.sheet && !shots) {
      const count = 12;
      for (let i = 0; i < count; i++) {
        const t = (total * (i + 0.5)) / count;
        writeFileSync(join(work, `sheet${String(i).padStart(3, '0')}.png`), await capture(t));
      }
      const sheet = resolve(opts.sheet);
      mkdirSync(dirname(sheet), { recursive: true });
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(work, 'sheet%03d.png'),
        '-vf', 'scale=480:-1,tile=4x3:padding=6:color=0x222222', '-frames:v', '1', sheet], { encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`contact sheet failed: ${r.error?.message || r.stderr}`);
      console.error(`sheet: ${sheet}`);
    } else if (shots) {
      // Captured now, laid out after the video, because composing replaces the player page.
      shotTiles = [];
      for (const shot of holdFrames(loaded.sb, forward.map((r) => r.inspect), fps)) {
        const image = join(work, `shot${String(shot.step).padStart(4, '0')}.png`);
        writeFileSync(image, await capture(shot.time));
        shotTiles.push({ image, label: shot.label });
      }
    }

    if (opts.video) {
      const out = resolve(opts.out || join(loaded.dir, `${name}.mp4`));
      mkdirSync(dirname(out), { recursive: true });
      // Encode beside the destination and rename at the end, so a failed or interrupted
      // render leaves the previous video in place.
      partialVideo = join(dirname(out), `.${basename(out, extname(out))}.partial-${process.pid}${extname(out) || '.mp4'}`);
      encoder = startEncoder(partialVideo, fps, opts.crf, renderFingerprint(loaded, fps));
      const started = Date.now();
      for (let i = 0; i < frames; i++) {
        await Promise.race([encoder.write(await capture(i / fps)), encoder.done]);
        if (i % (fps * 2) === 0 || i === frames - 1) {
          process.stderr.write(`\rframe ${i + 1}/${frames} (${Math.round((100 * (i + 1)) / frames)}%)`);
        }
      }
      await encoder.finish();
      encoder = null;
      renameSync(partialVideo, out);
      partialVideo = null;
      process.stderr.write('\n');
      console.error(`video: ${out} (${total.toFixed(1)}s, ${frames} frames, ${fps} fps, rendered in ${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }

    if (shotTiles) {
      const sheet = resolve(opts.sheet);
      mkdirSync(dirname(sheet), { recursive: true });
      const outputs = sheetPaths(sheet, pageCount(shotTiles.length));
      await composeSheets(session, shotTiles, outputs, { width, height, work });
      for (const [p, file] of outputs.entries()) console.error(`sheet: ${file} (${shotTiles.length} shots, page ${p + 1} of ${outputs.length})`);
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
