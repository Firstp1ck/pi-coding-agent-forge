// Delivery timeline and checks for assemble.mjs: chapters, FFmetadata, the copy-ready
// description, the render fingerprint, path aliasing and ffprobe verification.
// Chapter metadata and description timestamps come from one chapter list.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine } from './storyboard.mjs';
import { frameCount } from './layout.mjs';

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets');
const FINGERPRINT_PREFIX = 'explainer-video:';

/**
 * Tolerances for the finished file. Video is stream-copied, so frame count and rate are exact.
 * AAC encodes in 1024-sample packets and the muxer rounds to its time base, so the audio stream
 * may end up to one packet (21.3 ms at 48 kHz) away from the video, plus timestamp rounding.
 */
export const DELIVERY_TOLERANCE = {
  audioSeconds: 0.03,
  chapterSeconds: 0.001
};

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// Chapter titles go into FFmetadata and one description line each, so they must be one line.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Delivered length: the renderer encodes round(total * fps) frames, so this is what the
 * master holds even when the storyboard total is not a whole number of frames.
 */
export function deliveredTiming(sb, total) {
  const fps = sb.fps || 30;
  const frames = frameCount(total, fps);
  return { fps, frames, duration: frames / fps, width: sb.width || 1920, height: sb.height || 1080 };
}

/**
 * Chapter list for the delivery.
 * Explicit `chapters: [{start, title}]` must start at 0, rise strictly, stay before the end
 * and fall in different whole seconds (descriptions show whole seconds). Without it, every
 * section step starts a chapter titled with its section title, and a chapter at 0 titled with
 * the storyboard title (or "Start") is added when the first section starts later.
 * @param {object} sb validated storyboard
 * @param {number} duration delivered length in seconds
 * @returns {{chapters: {start:number, end:number, title:string}[], errors: string[], warnings: string[], source: string}}
 */
export function resolveChapters(sb, duration) {
  const errors = [];
  const warnings = [];
  let starts = [];
  let source;
  if (sb.chapters != null) {
    source = 'storyboard chapters';
    if (!Array.isArray(sb.chapters) || !sb.chapters.length) {
      errors.push('chapters must be a non-empty array of {start, title}');
    } else {
      sb.chapters.forEach((c, i) => {
        const at = `chapters[${i}]`;
        if (!isObject(c)) { errors.push(`${at} must be an object with start and title`); return; }
        if (typeof c.start !== 'number' || !Number.isFinite(c.start)) errors.push(`${at}.start must be a finite number of seconds`);
        if (typeof c.title !== 'string' || !c.title.trim()) errors.push(`${at}.title must be non-empty text`);
        starts.push({ start: c.start, title: typeof c.title === 'string' ? c.title.trim() : '' });
      });
    }
  } else {
    source = 'section steps';
    const timeline = engine.buildTimeline(sb);
    sb.steps.forEach((step, i) => {
      if (step.section) starts.push({ start: timeline.steps[i].start, title: String(step.section.title).trim() });
    });
    if (!starts.length || starts[0].start > 0) {
      starts.unshift({ start: 0, title: typeof sb.title === 'string' && sb.title.trim() ? sb.title.trim() : 'Start' });
    }
  }
  if (errors.length) return { chapters: [], errors, warnings, source };

  starts.forEach((c, i) => {
    const at = source === 'storyboard chapters' ? `chapters[${i}]` : `chapter ${i + 1} ("${c.title}")`;
    if (CONTROL.test(c.title)) errors.push(`${at}.title must be one line without control characters`);
    if (i === 0 && c.start !== 0) errors.push(`${at}.start must be 0; the first chapter starts the video`);
    if (c.start < 0) errors.push(`${at}.start must not be negative`);
    if (c.start >= duration) errors.push(`${at}.start (${c.start}s) must be before the end of the video (${duration}s)`);
    const prev = starts[i - 1];
    if (prev) {
      if (c.start <= prev.start) errors.push(`${at}.start (${c.start}s) must be later than the previous chapter (${prev.start}s)`);
      else if (Math.floor(Math.round(c.start * 1000) / 1000) === Math.floor(Math.round(prev.start * 1000) / 1000)) errors.push(`${at}.start (${c.start}s) falls in the same second as the previous chapter; description timestamps show whole seconds`);
    }
    if (Math.round(c.start * 1000) >= Math.round(duration * 1000)) errors.push(`${at}.start must be before the end after rounding to MP4 milliseconds`);
  });
  // Use the MP4's millisecond boundaries for descriptions too, including near a whole second.
  const rounded = starts.map(c => ({ ...c, start: Math.round(c.start * 1000) / 1000 }));
  const chapters = rounded.map((c, i) => ({ ...c, end: i + 1 < rounded.length ? rounded[i + 1].start : Math.round(duration * 1000) / 1000 }));
  if (!errors.length) {
    if (chapters.length < 3) warnings.push(`only ${chapters.length} chapter(s); YouTube shows chapters only with three or more`);
    chapters.forEach((c, i) => {
      if (c.end - c.start < 10) warnings.push(`chapter ${i + 1} ("${c.title}") lasts ${(c.end - c.start).toFixed(1)}s; YouTube needs at least 10s per chapter`);
    });
  }
  return { chapters: errors.length ? [] : chapters, errors, warnings, source };
}

/** Description timestamp for whole seconds: 00:00, 12:05, 1:02:03. */
export function clock(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

// Global video titles may be multiline; an escaped newline stays inside its metadata value.
const ffEscape = (s) => String(s).replace(/[=;#\\\r\n]/g, (c) => `\\${c}`);

/** FFmetadata text with millisecond chapter boundaries and the delivery's global tags. */
export function ffmetadata(chapters, { title, comment }) {
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${ffEscape(title)}`);
  if (comment) lines.push(`comment=${ffEscape(comment)}`);
  for (const c of chapters) {
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${ffEscape(c.title)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Copy-ready description: the storyboard title, then one "MM:SS Title" line per chapter. */
export function description(sb, chapters) {
  const lines = [];
  if (typeof sb.title === 'string' && sb.title.trim()) lines.push(sb.title.trim(), '');
  if (typeof sb.description === 'string' && sb.description.trim()) lines.push(sb.description.trim(), '');
  lines.push('Chapters');
  for (const c of chapters) lines.push(`${clock(c.start)} ${c.title}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Fingerprint of everything render.mjs draws from: the storyboard, scenes file, engine,
 * player template, step images, outro logo, frame size and rate. render.mjs stores it in the
 * MP4 comment tag; assemble.mjs recomputes it to detect a master from an older storyboard.
 * Files the scenes HTML loads by itself (its own images or fonts) are not included.
 */
export function renderFingerprint(loaded, fps) {
  const { sb, dir, scenesHtml } = loaded;
  const hash = createHash('sha256');
  const part = (label, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    hash.update(`${label}\0${buf.length}\0`);
    hash.update(buf);
  };
  part('storyboard', JSON.stringify(sb));
  part('scenes', scenesHtml);
  part('engine', readFileSync(join(ASSETS, 'engine.js')));
  part('player', readFileSync(join(ASSETS, 'player.html')));
  part('frame', `${sb.width || 1920}x${sb.height || 1080}@${fps}`);
  const files = [...(Array.isArray(sb.steps) ? sb.steps : []).map((s) => s?.image), sb.outro?.logo].filter((f) => typeof f === 'string' && f);
  for (const f of files) {
    const path = resolve(dir, f);
    part(`file:${f}`, existsSync(path) ? readFileSync(path) : 'missing');
  }
  return `${FINGERPRINT_PREFIX}${hash.digest('hex')}`;
}

/** The fingerprint stored in a probed file's comment tag, or null. */
export function storedFingerprint(probe) {
  const tags = probe.format?.tags || {};
  const value = tags.comment ?? tags.COMMENT ?? null;
  return typeof value === 'string' && value.startsWith(FINGERPRINT_PREFIX) ? value : null;
}

/**
 * Identity used to detect two paths naming the same file: device and inode for an existing
 * file, otherwise the real path of the nearest existing ancestor plus the remaining segments.
 */
export function pathIdentity(path, seenLinks = new Set()) {
  const abs = resolve(path);
  if (existsSync(abs)) {
    const st = statSync(abs);
    return { key: `inode:${st.dev}:${st.ino}`, real: realpathSync(abs) };
  }
  let base = abs;
  const rest = [];
  while (!existsSync(base)) {
    let target;
    try { target = readlinkSync(base); }
    catch (err) { if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(err.code)) throw err; }
    if (target != null) {
      if (seenLinks.has(base)) throw new Error(`circular symbolic link while resolving ${path}`);
      seenLinks.add(base);
      return pathIdentity(resolve(dirname(base), target, ...rest), seenLinks);
    }
    rest.unshift(basename(base));
    const up = dirname(base);
    if (up === base) break;
    base = up;
  }
  const real = join(realpathSync(base), ...rest);
  return { key: `path:${real}`, real };
}

/**
 * Report every pair of roles that names the same file. Inputs may coincide only with each
 * other; any output that matches an input or another output is an error.
 * @param {{role: string, path: string, output: boolean}[]} entries
 * @returns {string[]} errors
 */
export function aliasErrors(entries) {
  const errors = [];
  const ids = entries.map((e) => ({ ...e, id: pathIdentity(e.path) }));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (!a.output && !b.output) continue;
      if (a.id.key === b.id.key || a.id.real === b.id.real) {
        errors.push(`${a.role} (${a.path}) and ${b.role} (${b.path}) are the same file; choose a different path`);
      }
    }
  }
  return errors;
}

const ratio = (r) => {
  const [n, d] = String(r || '0/1').split('/').map(Number);
  return d ? n / d : NaN;
};

/**
 * Check a probed video stream against the storyboard's frame size, rate and frame count.
 * @param {object} probe ffprobe JSON with -show_streams -count_packets
 * @returns {string[]} errors, empty when the stream matches
 */
export function videoErrors(probe, expected, label) {
  const videos = (probe.streams || []).filter((s) => s.codec_type === 'video');
  if (videos.length !== 1) return [`${label} has ${videos.length} video streams; expected 1`];
  const v = videos[0];
  const errors = [];
  if (v.codec_name !== 'h264') errors.push(`${label} video codec is ${v.codec_name}; expected h264 from render.mjs`);
  if (v.width !== expected.width || v.height !== expected.height) {
    errors.push(`${label} is ${v.width}x${v.height}; the storyboard is ${expected.width}x${expected.height}`);
  }
  const rate = ratio(v.avg_frame_rate);
  if (Math.abs(rate - expected.fps) > 1e-6) errors.push(`${label} runs at ${v.avg_frame_rate} fps; the storyboard uses ${expected.fps}`);
  const frames = Number(v.nb_read_packets ?? v.nb_frames);
  if (frames !== expected.frames) {
    errors.push(`${label} has ${frames} frames (${(frames / expected.fps).toFixed(3)}s); the storyboard needs ${expected.frames} (${expected.duration.toFixed(3)}s). Re-render the master`);
  }
  return errors;
}

/** Duration of the first audio stream in seconds, or null when there is none. */
export function audioDuration(probe) {
  const a = (probe.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) return null;
  const d = Number(a.duration ?? probe.format?.duration);
  return Number.isFinite(d) ? d : null;
}

/**
 * Check the finished file: video as the master, the AAC soundtrack length when one was
 * supplied (none otherwise), and chapters exactly as written.
 * @returns {string[]} errors
 */
export function deliveryErrors(probe, expected, chapters, withAudio) {
  const errors = videoErrors(probe, expected, 'delivered MP4');
  const audio = (probe.streams || []).filter((s) => s.codec_type === 'audio');
  if (withAudio) {
    if (audio.length !== 1) errors.push(`delivered MP4 has ${audio.length} audio streams; expected 1`);
    else {
      if (audio[0].codec_name !== 'aac') errors.push(`delivered audio codec is ${audio[0].codec_name}; expected aac`);
      const d = audioDuration(probe);
      if (d == null || Math.abs(d - expected.duration) > DELIVERY_TOLERANCE.audioSeconds) {
        errors.push(`delivered audio lasts ${d}s; the video lasts ${expected.duration.toFixed(3)}s (tolerance ${DELIVERY_TOLERANCE.audioSeconds}s)`);
      }
    }
  } else if (audio.length) {
    errors.push(`delivered MP4 has ${audio.length} audio streams; none was supplied`);
  }
  const found = probe.chapters || [];
  if (found.length !== chapters.length) {
    errors.push(`delivered MP4 has ${found.length} chapters; expected ${chapters.length}`);
  } else {
    chapters.forEach((c, i) => {
      const f = found[i];
      const tol = DELIVERY_TOLERANCE.chapterSeconds;
      if (Math.abs(Number(f.start_time) - c.start) > tol || Math.abs(Number(f.end_time) - c.end) > tol || f.tags?.title !== c.title) {
        errors.push(`delivered chapter ${i + 1} is ${f.start_time}–${f.end_time}s "${f.tags?.title}"; expected ${c.start}–${c.end}s "${c.title}"`);
      }
    });
  }
  return errors;
}
