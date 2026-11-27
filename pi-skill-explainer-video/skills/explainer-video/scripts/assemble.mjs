#!/usr/bin/env node
/*
 * Assemble a delivery MP4 from a rendered visual master: stream-copied H.264 video, an
 * optional soundtrack converted to AAC, embedded chapters and a copy-ready description,
 * all from one chapter timeline. Every output is staged next to its destination, verified
 * with ffprobe and only then moved into place, so a failure leaves earlier files untouched.
 *
 * Needs Node 22+ and ffmpeg/ffprobe; --sheet also needs a Chromium-family browser.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStoryboard, validateStoryboard, buildPage } from './lib/storyboard.mjs';
import { which, findChromium, openBrowser, loadPlayer } from './lib/browser.mjs';
import { runBounded, killRunning } from './lib/proc.mjs';
import { PAGE_HELPER, sampleFrames } from './lib/layout.mjs';
import { holdFrames, sheetPaths, pageCount, composeSheets } from './lib/sheet.mjs';
import {
  DELIVERY_TOLERANCE, deliveredTiming, resolveChapters, ffmetadata, description, renderFingerprint,
  storedFingerprint, aliasErrors, videoErrors, audioDuration, deliveryErrors
} from './lib/delivery.mjs';

const USAGE = `usage: assemble.mjs <storyboard.json> --visual <master.mp4> --out <delivery.mp4> [options]

  --visual <file.mp4>      visual master from render.mjs for this storyboard
  --out <file.mp4>         delivery MP4 to write
  --audio <file>           soundtrack, converted to AAC and trimmed to the video;
                           it must cover the storyboard; frame rounding is padded
  --description <file>     copy-ready description with chapter timestamps
                           (default: <out without .mp4>.description.txt)
  --sheet <file.png>       shot contact sheet decoded from the delivered MP4;
                           more than 32 steps continue in <file>-p2.png, -p3.png, ...
  --chromium <path>        browser for --sheet (default: $CHROME_PATH, then PATH lookup)

Chapters come from the storyboard's "chapters": [{"start", "title"}] list when present,
otherwise from its section steps, with a chapter at 0:00 added when needed.`;

const PROBE_TIMEOUT_MS = 60_000;
// Allow source timestamp rounding; only the storyboard's fractional final frame is padded.
const AUDIO_SHORT_SLACK = 0.01;

class UsageError extends Error {}

// The sheet step's browser, so a signal handler can stop its process group.
let liveSession = null;

function parseArgs(argv) {
  const opts = {};
  const valueFlags = new Set(['--visual', '--out', '--audio', '--description', '--sheet', '--chromium']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (valueFlags.has(a)) {
      const v = argv[++i];
      if (v == null || v === '') throw new UsageError(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (!opts.file) opts.file = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.file) throw new UsageError('missing storyboard path');
  if (!opts.visual) throw new UsageError('--visual is required');
  if (!opts.out) throw new UsageError('--out is required');
  if (!/\.mp4$/i.test(opts.out)) throw new UsageError('--out must end in .mp4');
  if (opts.sheet && !/\.png$/i.test(opts.sheet)) throw new UsageError('--sheet must end in .png');
  return opts;
}

async function probe(file, what) {
  const { stdout } = await runBounded('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-count_packets', file],
    { timeoutMs: PROBE_TIMEOUT_MS, what: `probing ${what} ${file}` });
  return JSON.parse(stdout.toString('utf8'));
}

/** Staged sibling of `dest` with the same extension, so ffmpeg picks the right muxer and rename stays on one filesystem. */
const stagedPath = (dest) => join(dirname(dest), `.${basename(dest, extname(dest))}.assemble-${process.pid}${extname(dest)}`);

function fail(errors) {
  throw new Error(errors.length === 1 ? errors[0] : `${errors.length} problems:\n  ${errors.join('\n  ')}`);
}

/** Decode the hold frame of every step from the staged delivery and lay them out as sheet pages. */
async function buildSheet({ loaded, timing, staged, outputs, work, chromium }) {
  const pagePath = join(work, 'page.html');
  writeFileSync(pagePath, buildPage(loaded, { play: false }));
  const session = await openBrowser(findChromium(chromium), join(work, 'profile'));
  liveSession = session;
  try {
    await loadPlayer(session, pathToFileURL(pagePath).href, timing.width, timing.height);
    await session.evaluate(PAGE_HELPER);
    const all = Array.from({ length: timing.frames }, (_, k) => k);
    const samples = await sampleFrames(session, all, timing.fps, (done) => process.stderr.write(`\rsheet: inspecting ${done}/${timing.frames} frames`));
    process.stderr.write('\n');
    const shots = holdFrames(loaded.sb, samples.map((r) => r.inspect), timing.fps);
    const select = shots.map((s) => `eq(n,${s.frame})`).join('+');
    await runBounded('ffmpeg', ['-v', 'error', '-i', staged, '-vf', `select='${select}'`, '-fps_mode', 'passthrough', join(work, 'shot%04d.png')],
      { timeoutMs: 120_000 + timing.duration * 1000, what: 'decoding shot frames from the delivered MP4' });
    const tiles = shots.map((s, i) => ({ image: join(work, `shot${String(i + 1).padStart(4, '0')}.png`), label: s.label }));
    await composeSheets(session, tiles, outputs, { width: timing.width, height: timing.height, work });
    return shots.length;
  } finally {
    liveSession = null;
    await session.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`error: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  for (const tool of ['ffmpeg', 'ffprobe']) if (!which(tool)) throw new Error(`${tool} not found on PATH`);

  const loaded = loadStoryboard(opts.file);
  const { errors, warnings, total } = validateStoryboard(loaded.sb, { scenes: loaded.scenes, dir: loaded.dir });
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length) fail(errors.map((e) => `storyboard: ${e}`));

  const timing = deliveredTiming(loaded.sb, total);
  const chapterPlan = resolveChapters(loaded.sb, timing.duration);
  for (const w of chapterPlan.warnings) console.error(`warning: ${w}`);
  if (chapterPlan.errors.length) fail(chapterPlan.errors);
  const { chapters } = chapterPlan;

  const out = resolve(opts.out);
  const visual = resolve(opts.visual);
  const audio = opts.audio ? resolve(opts.audio) : null;
  const descriptionPath = resolve(opts.description || out.replace(/\.mp4$/i, '.description.txt'));
  const sheet = opts.sheet ? resolve(opts.sheet) : null;
  const pathRoles = (sheetPages) => [
    { role: 'storyboard', path: resolve(opts.file), output: false },
    ...(loaded.sb.scenes ? [{ role: 'scenes file', path: resolve(loaded.dir, loaded.sb.scenes), output: false }] : []),
    ...loaded.sb.steps.filter((step) => step.image).map((step) => ({ role: 'step image', path: resolve(loaded.dir, step.image), output: false })),
    ...(loaded.sb.outro?.logo ? [{ role: 'outro logo', path: resolve(loaded.dir, loaded.sb.outro.logo), output: false }] : []),
    { role: '--visual', path: visual, output: false },
    ...(audio ? [{ role: '--audio', path: audio, output: false }] : []),
    { role: '--out', path: out, output: true },
    { role: 'description', path: descriptionPath, output: true },
    ...sheetPages.map((p, i) => ({ role: i ? `sheet page ${i + 1}` : '--sheet', path: p, output: true }))
  ];
  const sheetOutputs = sheet ? sheetPaths(sheet, pageCount(loaded.sb.steps.length)) : [];
  const aliases = aliasErrors(pathRoles(sheetOutputs));
  if (aliases.length) fail(aliases);

  const master = await probe(visual, 'visual master');
  const masterErrors = videoErrors(master, timing, 'visual master');
  const stored = storedFingerprint(master);
  if (!stored) masterErrors.push(`visual master ${visual} has no render fingerprint; render it with render.mjs from this storyboard`);
  else if (stored !== renderFingerprint(loaded, timing.fps)) {
    masterErrors.push(`visual master ${visual} was rendered from a different storyboard, scenes, images or engine; re-render it`);
  }
  if (audio) {
    const sound = await probe(audio, 'soundtrack');
    const d = audioDuration(sound);
    if (d == null) masterErrors.push(`soundtrack ${audio} has no audio stream with a known duration`);
    else if (d < Math.min(total, timing.duration) - AUDIO_SHORT_SLACK) {
      masterErrors.push(`soundtrack ${audio} lasts ${d.toFixed(3)}s and ends ${(timing.duration - d).toFixed(3)}s before the ${timing.duration.toFixed(3)}s video`);
    }
  }
  if (masterErrors.length) fail(masterErrors);

  const work = mkdtempSync(join(tmpdir(), 'explainer-assemble-'));
  const stagedOut = stagedPath(out);
  const stagedDescription = stagedPath(descriptionPath);
  const stagedSheets = sheetOutputs.map(stagedPath);
  const staged = [stagedOut, stagedDescription, ...stagedSheets];
  const cleanup = () => {
    for (const f of staged) rmSync(f, { force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  const onSignal = () => {
    killRunning();
    Promise.resolve(liveSession?.close()).finally(() => { cleanup(); process.exit(130); });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    for (const dest of [out, descriptionPath, ...sheetOutputs]) mkdirSync(dirname(dest), { recursive: true });
    const metaPath = join(work, 'chapters.ffmeta');
    writeFileSync(metaPath, ffmetadata(chapters, { title: loaded.sb.title, comment: stored }));
    const metaInput = audio ? 2 : 1;
    const args = ['-y', '-v', 'error', '-i', visual,
      ...(audio ? ['-i', audio] : []),
      '-f', 'ffmetadata', '-i', metaPath,
      '-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : []),
      '-map_metadata', String(metaInput), '-map_chapters', String(metaInput),
      '-c:v', 'copy', ...(audio ? ['-af', `asetpts=PTS-STARTPTS,apad,atrim=duration=${timing.duration}`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
      '-movflags', '+faststart', '-f', 'mp4', stagedOut];
    await runBounded('ffmpeg', args, { timeoutMs: 120_000 + timing.duration * 2000, what: 'muxing the delivery MP4' });

    const delivered = await probe(stagedOut, 'staged delivery');
    const problems = deliveryErrors(delivered, timing, chapters, !!audio);
    if (problems.length) fail(problems);

    if (sheet) {
      const shots = await buildSheet({ loaded, timing, staged: stagedOut, outputs: stagedSheets, work, chromium: opts.chromium });
      console.error(`sheet: ${shots} shots decoded from the delivered MP4`);
    }
    writeFileSync(stagedDescription, description(loaded.sb, chapters));

    // The MP4 moves last: if an earlier rename fails, the previous delivery is still whole.
    const moves = [...stagedSheets.map((s, i) => [s, sheetOutputs[i]]), [stagedDescription, descriptionPath], [stagedOut, out]];
    const done = [];
    for (const [from, to] of moves) {
      try {
        renameSync(from, to);
      } catch (err) {
        throw new Error(`verified, but moving ${basename(from)} to ${to} failed: ${err.message}${done.length ? `; already replaced: ${done.join(', ')}` : ''}`);
      }
      done.push(to);
    }
    const audioNote = audio ? `, AAC soundtrack within ${DELIVERY_TOLERANCE.audioSeconds}s` : ', no audio';
    console.error(`video: ${out} (${timing.frames} frames, ${timing.width}x${timing.height}, ${timing.fps} fps${audioNote}, ${chapters.length} chapters from ${chapterPlan.source})`);
    console.error(`description: ${descriptionPath}`);
    for (const [p, file] of sheetOutputs.entries()) console.error(`sheet: ${file} (page ${p + 1} of ${sheetOutputs.length})`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
