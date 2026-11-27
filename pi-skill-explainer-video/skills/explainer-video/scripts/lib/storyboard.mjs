// Storyboard loading, validation and page assembly shared by validate.mjs and render.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets');
const engine = require(join(ASSETS, 'engine.js'));

export const ACTION_TYPES = new Set(['type', 'text', 'class', 'show', 'hide']);
export const SECTION_KINDS = new Set(['opening', 'chapter', 'closing']);
// A section card holds the app still under its title, so these step fields have nothing to drive.
const SECTION_FORBIDDEN = ['caption', 'camera', 'spotlights', 'highlights', 'cursor', 'keys', 'actions', 'focusFade', 'avoid'];

// Words a non-technical viewer is likely to stumble on in a caption. Product
// names and terms the audience already knows go in the storyboard's allowTerms.
export const JARGON = [
  'api', 'cli', 'tui', 'gui', 'sdk', 'repo', 'repository', 'repositories', 'config', 'configuration',
  'dependency', 'dependencies', 'daemon', 'binary', 'binaries', 'runtime', 'backend', 'frontend',
  'endpoint', 'payload', 'schema', 'sync', 'syncs', 'instance', 'deploy', 'build', 'compile', 'cache',
  'worktree', 'branch', 'commit', 'merge', 'mcp', 'aur', 'pkgbuild', 'pacman', 'sudo', 'root', 'shell',
  'flag', 'parameter', 'toggle', 'modal', 'webhook', 'token', 'json', 'yaml', 'ssh'
];
// Filler and hype that make captions longer without telling the viewer anything.
export const FILLER = [
  'simply', 'just', 'easily', 'seamless', 'seamlessly', 'powerful', 'robust', 'leverage', 'utilize',
  'effortless', 'effortlessly', 'blazing', 'revolutionary', 'cutting-edge', 'next-generation', 'unlock', 'supercharge'
];

const LIMITS = {
  stepMin: 2, stepMax: 6, stepIdealMin: 3, stepIdealMax: 5,
  durMin: 3, durMax: 12, totalWarn: 45,
  boldWordsMax: 4, captionWordsWarn: 10, captionWordsMax: 14, outroLineWordsWarn: 5,
  sectionTitleWordsWarn: 8, sectionBodyWordsWarn: 24, sectionCreditWordsWarn: 12
};

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/**
 * Read a storyboard and its scenes file.
 * @param {string} file path to storyboard JSON
 * @returns {{sb: object, dir: string, scenesHtml: string, scenes: Map<string,{width:number,height:number}>}}
 * @throws {Error} on unreadable or malformed JSON, or a missing scenes file
 */
export function loadStoryboard(file) {
  const path = resolve(file);
  let sb;
  try {
    sb = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read storyboard ${path}: ${err.message}`);
  }
  if (!isObject(sb)) throw new Error(`Storyboard ${path} must contain a JSON object`);
  const dir = dirname(path);
  let scenesHtml = '';
  if (sb.scenes) {
    const scenesPath = resolve(dir, sb.scenes);
    if (!existsSync(scenesPath)) throw new Error(`Scenes file not found: ${scenesPath}`);
    scenesHtml = readFileSync(scenesPath, 'utf8');
  }
  return { sb, dir, scenesHtml, scenes: parseScenes(scenesHtml) };
}

/** Find <template id=".."> blocks and their declared data-width/data-height. */
export function parseScenes(html) {
  const scenes = new Map();
  for (const m of html.matchAll(/<template\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = /\bid=(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/.exec(attrs)?.slice(1).find(Boolean);
    if (!id) continue;
    scenes.set(id, {
      width: Number(/\bdata-width=["']?(\d+)/.exec(attrs)?.[1] || 1920),
      height: Number(/\bdata-height=["']?(\d+)/.exec(attrs)?.[1] || 1080)
    });
  }
  return scenes;
}

function checkRect(spec, where, size, errors) {
  if (Array.isArray(spec)) {
    if (spec.length !== 4 || spec.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`${where}: rect must be [x, y, width, height] numbers`);
      return;
    }
    const [x, y, w, h] = spec;
    if (w <= 0 || h <= 0) errors.push(`${where}: rect width and height must be positive`);
    if (size && (x < -size.width * 0.25 || y < -size.height * 0.25 || x + w > size.width * 1.25 || y + h > size.height * 1.25)) {
      errors.push(`${where}: rect [${spec.join(', ')}] lies far outside the ${size.width}x${size.height} scene`);
    }
  } else if (!spec || typeof spec.target !== 'string' || !spec.target) {
    errors.push(`${where}: rect must be [x, y, w, h] or {"target": "<css selector>", "pad"?: number}`);
  } else if (spec.pad != null && (typeof spec.pad !== 'number' || !Number.isFinite(spec.pad))) {
    errors.push(`${where}: pad must be a finite number`);
  }
}

const isDuration = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Section card fields, placement and ramps. Kept apart from caption checks: sections have no caption. */
function checkSection(step, i, count, sb, allow, errors, warnings) {
  const at = `step ${i + 1}`;
  const s = step.section;
  if (!isObject(s)) {
    errors.push(`${at}: section must be an object`);
    return;
  }
  if (!SECTION_KINDS.has(s.kind)) errors.push(`${at}: section.kind must be one of ${[...SECTION_KINDS].join(', ')}`);
  if (s.kind === 'opening' && i !== 0) errors.push(`${at}: an opening section must be the first step`);
  if (s.kind === 'closing' && i !== count - 1) errors.push(`${at}: a closing section must be the last step`);
  if (s.kind === 'closing' && sb.outro) errors.push(`${at}: a closing section replaces the outro; remove one of them`);
  const texts = [['title', true, LIMITS.sectionTitleWordsWarn], ['body', false, LIMITS.sectionBodyWordsWarn], ['credit', false, LIMITS.sectionCreditWordsWarn]];
  for (const [field, required, warnAt] of texts) {
    const value = s[field];
    if (value == null && !required) continue;
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${at}: section.${field} ${required ? 'is required and ' : ''}must be non-empty text`);
      continue;
    }
    const n = words(value).length;
    if (n > warnAt) warnings.push(`${at}: section.${field} has ${n} words; keep it to ${warnAt} or fewer so it reads in one glance`);
    checkWording(value, `${at} section.${field}`, allow, warnings);
  }
  for (const field of ['fadeIn', 'fadeOut']) {
    if (s[field] != null && !isDuration(s[field])) errors.push(`${at}: section.${field} must be a nonnegative number of seconds`);
  }
  if (s.shade != null && !(typeof s.shade === 'number' && s.shade >= 0 && s.shade <= 1)) errors.push(`${at}: section.shade must be a number from 0 to 1`);
  const ramps = (isDuration(s.fadeIn) ? s.fadeIn : 0.5) + (isDuration(s.fadeOut) ? s.fadeOut : 0.5);
  if (typeof step.duration === 'number' && ramps > step.duration) {
    errors.push(`${at}: section fadeIn and fadeOut (${ramps}s together) must fit inside the ${step.duration}s hold`);
  }
  for (const field of SECTION_FORBIDDEN) {
    if (step[field] != null) errors.push(`${at}: a section card holds the app still; remove ${field}`);
  }
}

function checkTime(value, where, duration, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${where}: time must be a number of seconds`);
  else if (value < 0 || value > duration) errors.push(`${where}: time ${value}s is outside the step (0–${duration}s)`);
}

/** Plain-language caption checks. Returns warnings only; the author decides. */
function checkWording(text, where, allow, warnings) {
  for (const token of words(text)) {
    const raw = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, '');
    const w = raw.toLowerCase();
    if (!w || allow.has(w)) continue;
    if (JARGON.includes(w)) warnings.push(`${where}: "${raw}" may be jargon for a non-technical viewer; say what it does, or add it to allowTerms`);
    if (FILLER.includes(w)) warnings.push(`${where}: "${raw}" is filler; cut it`);
  }
}

/**
 * Validate a storyboard.
 * @param {object} sb storyboard
 * @param {{scenes?: Map<string,{width:number,height:number}>, dir?: string}} ctx
 * @returns {{errors: string[], warnings: string[], total: number}}
 */
export function validateStoryboard(sb, ctx = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(sb)) return { errors: ['the storyboard must be a JSON object'], warnings, total: 0 };
  const scenes = ctx.scenes || new Map();
  // Optional lists: absent is fine, any other non-array is a shape error. Non-object items are dropped after reporting.
  const list = (value, where) => {
    if (value == null) return [];
    if (!Array.isArray(value)) { errors.push(`${where} must be an array`); return []; }
    return value.filter((item, j) => {
      if (isObject(item)) return true;
      errors.push(`${where}[${j}] must be an object`);
      return false;
    });
  };
  if (sb.allowTerms != null && !Array.isArray(sb.allowTerms)) errors.push('allowTerms must be an array of words');
  if (sb.description != null && (typeof sb.description !== 'string' || !sb.description.trim())) errors.push('description must be non-empty text');
  const allow = new Set((Array.isArray(sb.allowTerms) ? sb.allowTerms : []).map((t) => String(t).toLowerCase()));

  if (sb.spotlightOutline != null && typeof sb.spotlightOutline !== 'boolean') errors.push('spotlightOutline must be a boolean');
  if (sb.captionMotion != null && sb.captionMotion !== 'continuous') errors.push('captionMotion must be "continuous" when specified');
  if (sb.captionEase != null && sb.captionEase !== 'fast-slow') errors.push('captionEase must be "fast-slow" when specified');
  if (sb.captionStyle != null && sb.captionStyle !== 'two-line') errors.push('captionStyle must be "two-line" when specified');
  if (sb.framing != null && sb.framing !== 'full-app') errors.push('framing must be "full-app" when specified');
  if (sb.framing === 'full-app' && sb.outro) errors.push('full-app framing uses a final on-screen caption in place of an outro');
  if (sb.version !== 1) errors.push('version must be 1');
  for (const key of ['width', 'height', 'fps']) {
    if (sb[key] != null && (!Number.isInteger(sb[key]) || sb[key] <= 0)) errors.push(`${key} must be a positive integer`);
  }
  if (sb.fps != null && (sb.fps < 12 || sb.fps > 60)) errors.push('fps must be between 12 and 60');
  if ((sb.width ?? 1920) !== 1920 || (sb.height ?? 1080) !== 1080) {
    warnings.push('the layout is tuned for 1920x1080; other sizes need a matching "view" box and caption position');
  }

  const rawSteps = Array.isArray(sb.steps) ? sb.steps : [];
  if (!Array.isArray(sb.steps)) errors.push('steps must be an array');
  const steps = rawSteps.filter((step, i) => {
    if (isObject(step)) return true;
    errors.push(`step ${i + 1} must be an object`);
    return false;
  });
  const episode = sb.format === 'episode';
  if (sb.format != null && !episode && sb.format !== 'clip') errors.push('format must be "clip" or "episode"');
  if (episode && steps.length < LIMITS.stepMin) {
    errors.push(`an episode needs at least ${LIMITS.stepMin} steps`);
  } else if (!episode && (steps.length < LIMITS.stepMin || steps.length > LIMITS.stepMax)) {
    errors.push(`use ${LIMITS.stepMin}–${LIMITS.stepMax} steps (found ${steps.length})`);
  } else if (!episode && (steps.length < LIMITS.stepIdealMin || steps.length > LIMITS.stepIdealMax)) {
    warnings.push(`3–5 steps read best; this video has ${steps.length}`);
  }

  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    const d = step.duration;
    if (typeof d !== 'number' || d < LIMITS.durMin || d > LIMITS.durMax) {
      errors.push(`${at}: duration must be ${LIMITS.durMin}–${LIMITS.durMax} seconds`);
    }
    const dur = typeof d === 'number' ? d : 0;

    if (step.transition != null && !['fade', 'cut'].includes(step.transition)) {
      errors.push(`${at}: transition must be "fade" or "cut"`);
    }
    if (step.drift != null && typeof step.drift !== 'boolean') errors.push(`${at}: drift must be a boolean`);
    let size = null;
    if (step.image != null && typeof step.image !== 'string') {
      errors.push(`${at}: image must be a file path`);
    } else if (step.image) {
      if (step.scene) errors.push(`${at}: use either "scene" or "image", not both`);
      if (ctx.dir && !existsSync(resolve(ctx.dir, step.image))) errors.push(`${at}: image not found: ${step.image}`);
      if (step.imageSize) size = { width: step.imageSize[0], height: step.imageSize[1] };
    } else if (!step.scene) {
      errors.push(`${at}: needs "scene" (a template id) or "image" (a screenshot path)`);
    } else if (!scenes.has(step.scene)) {
      errors.push(`${at}: scene "${step.scene}" is not a <template id> in the scenes file`);
    } else {
      size = scenes.get(step.scene);
    }

    const section = step.section != null;
    if (section) checkSection(step, i, steps.length, sb, allow, errors, warnings);

    // Sections carry a title card instead of a caption; checkSection reports a stray caption.
    const c = step.caption;
    if (!section) {
      if (!isObject(c) || typeof c.bold !== 'string' || !c.bold.trim()) {
        errors.push(`${at}: caption.bold is required`);
      } else {
        if (sb.captionMotion === 'continuous') {
          // A section card between two shots starts a new caption sequence.
          const previous = steps[i - 1]?.section == null ? steps[i - 1]?.caption : null;
          const end = Array.isArray(previous?.track) ? previous.track.at(-1) : null;
          if (!Array.isArray(c.box)) errors.push(`${at}: continuous captions need a caption.box`);
          if (Array.isArray(c.box) && Array.isArray(previous?.box) &&
              (c.box[0] !== (end?.x ?? previous.box[0]) || c.box[1] !== (end?.y ?? previous.box[1]) || c.box[2] !== previous.box[2])) {
            errors.push(`${at}: continuous caption must start at the previous endpoint with the same width`);
          }
        }
        if (c.box != null) {
          const box = c.box;
          if (!Array.isArray(box) || box.length !== 3 || !box.every(Number.isFinite) ||
              box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[0] + box[2] > (sb.width || 1920) || box[1] >= (sb.height || 1080)) {
            errors.push(`${at}: caption.box must be an on-screen [left, top, width] in output pixels`);
          }
        }
        if (c.track != null) {
          if (!Array.isArray(c.box)) errors.push(`${at}: caption.track needs a starting caption.box`);
          let previousTime = 0;
          list(c.track, `${at} caption.track`).forEach((key, j) => {
            const where = `${at} caption.track[${j}]`;
            checkTime(key.at, `${where}.at`, dur, errors);
            if (key.at <= previousTime) errors.push(`${where}: arrival must be later than the preceding position`);
            previousTime = key.at;
            if (!Number.isFinite(key.x) || key.x < 0 || key.x + (c.box?.[2] || 0) > (sb.width || 1920) ||
                !Number.isFinite(key.y) || key.y < 0 || key.y >= (sb.height || 1080)) {
              errors.push(`${where}: x and y must place the caption inside the frame`);
            }
            if (sb.captionMotion === 'continuous' && (key.move === 0 || key.transition === 'fade')) {
              errors.push(`${where}: continuous caption movement needs a visible glide`);
            }
            if (key.move != null && (!Number.isFinite(key.move) || key.move < 0)) errors.push(`${where}: move must be a nonnegative duration`);
            if (key.transition != null && !['glide', 'fade'].includes(key.transition)) errors.push(`${where}: transition must be glide or fade`);
          });
        }
        const bold = words(c.bold).length;
        const total = bold + words(c.rest).length;
        if (bold > LIMITS.boldWordsMax) warnings.push(`${at}: bold lead has ${bold} words; keep it to ${LIMITS.boldWordsMax} or fewer`);
        if (total > LIMITS.captionWordsMax) errors.push(`${at}: caption has ${total} words; the limit is ${LIMITS.captionWordsMax}`);
        else if (total > LIMITS.captionWordsWarn) warnings.push(`${at}: caption has ${total} words; aim for ${LIMITS.captionWordsWarn} or fewer`);
        const full = `${c.bold} ${c.rest || ''}`.trim();
        if (!/[.!?]$/.test(full)) warnings.push(`${at}: end the caption with a full stop so it reads as a sentence`);
        checkWording(full, `${at} caption`, allow, warnings);
      }
    }

    list(step.camera, `${at} camera`).forEach((k, j) => {
      checkTime(k.at, `${at} camera[${j}]`, dur, errors);
      checkRect(k.rect, `${at} camera[${j}]`, size, errors);
    });
    list(step.spotlights, `${at} spotlights`).forEach((spot, j) => {
      const where = `${at} spotlights[${j}]`;
      checkTime(spot.from, `${where}.from`, dur, errors);
      if (spot.to != null) {
        checkTime(spot.to, `${where}.to`, dur, errors);
        if (spot.to <= spot.from) errors.push(`${where}: "to" must be after "from"`);
      }
      checkRect(spot.rect, `${where}.rect`, size, errors);
    });
    list(step.highlights, `${at} highlights`).forEach((h, j) => {
      checkTime(h.from, `${at} highlights[${j}].from`, dur, errors);
      if (h.to != null) {
        checkTime(h.to, `${at} highlights[${j}].to`, dur, errors);
        if (h.to <= h.from) errors.push(`${at} highlights[${j}]: "to" must be after "from"`);
      }
      checkRect(h.rect, `${at} highlights[${j}]`, size, errors);
    });
    list(step.cursor, `${at} cursor`).forEach((k, j) => {
      checkTime(k.at, `${at} cursor[${j}]`, dur, errors);
      if (typeof k.x !== 'number' || typeof k.y !== 'number') errors.push(`${at} cursor[${j}]: x and y must be numbers`);
    });
    list(step.keys, `${at} keys`).forEach((k, j) => {
      checkTime(k.at, `${at} keys[${j}]`, dur, errors);
      if (!k.label) errors.push(`${at} keys[${j}]: label is required`);
    });
    const checkAction = (a, where, timed) => {
      if (!ACTION_TYPES.has(a.type)) errors.push(`${where}: type must be one of ${[...ACTION_TYPES].join(', ')}`);
      if (typeof a.target !== 'string' || !a.target) errors.push(`${where}: target must be a CSS selector`);
      if (a.type === 'show' || a.type === 'hide') {
        for (const axis of ['dx', 'dy']) {
          if (a[axis] != null && !Number.isFinite(a[axis])) errors.push(`${where}: ${axis} must be a finite number`);
        }
      }
      if (timed) checkTime(a.at, where, dur, errors);
      if (a.type === 'type' && typeof a.text !== 'string') errors.push(`${where}: "type" needs text`);
      if (a.type === 'text' && typeof a.text !== 'string' && typeof a.html !== 'string') errors.push(`${where}: "text" needs text or html`);
      if (a.type === 'class' && !a.add && !a.remove) errors.push(`${where}: "class" needs add or remove`);
    };
    list(step.setup, `${at} setup`).forEach((a, j) => checkAction(a, `${at} setup[${j}]`, false));
    list(step.actions, `${at} actions`).forEach((a, j) => checkAction(a, `${at} actions[${j}]`, true));

    if (step.focusFade != null && !section) {
      const start = engine.focusStart({ spotlights: (Array.isArray(step.spotlights) ? step.spotlights : []).filter(isObject) });
      if (!isDuration(step.focusFade)) errors.push(`${at}: focusFade must be a nonnegative number of seconds`);
      else if (start + step.focusFade > dur) errors.push(`${at}: focusFade of ${step.focusFade}s starting at ${start}s runs past the ${dur}s step`);
      const previous = steps[i - 1];
      if (sb.captionMotion === 'continuous' && previous && !previous.section) {
        errors.push(`${at}: focusFade would hide a continuous caption mid-sequence; use it on the first step or after a section`);
      }
    }
    if (step.avoid != null && !section) {
      if (!Array.isArray(step.avoid)) errors.push(`${at} avoid must be an array of rects`);
      else step.avoid.forEach((rect, j) => checkRect(rect, `${at} avoid[${j}]`, size, errors));
    }

    const moves = (key) => (Array.isArray(step[key]) ? step[key].length : 0);
    if (!section && sb.framing !== 'full-app' && step.drift !== false && !moves('spotlights') && !moves('highlights') && moves('camera') < 2 && !moves('actions') && !moves('cursor')) {
      warnings.push(`${at}: nothing moves or gets highlighted; add a camera move, a highlight or an action`);
    }
  });

  if (sb.outro != null && !isObject(sb.outro)) {
    errors.push('outro must be an object');
  } else if (sb.outro) {
    const o = sb.outro;
    if (!Array.isArray(o.title) || o.title.length < 1 || o.title.length > 2) errors.push('outro.title must be one or two lines');
    else o.title.forEach((line, i) => {
      if (words(line).length > LIMITS.outroLineWordsWarn) warnings.push(`outro.title[${i}] has ${words(line).length} words; keep each line short`);
      checkWording(line, `outro.title[${i}]`, allow, warnings);
    });
    if (o.duration != null && (typeof o.duration !== 'number' || o.duration < 2 || o.duration > 8)) errors.push('outro.duration must be 2–8 seconds');
    if (o.logo && ctx.dir && !existsSync(resolve(ctx.dir, o.logo))) errors.push(`outro logo not found: ${o.logo}`);
  } else if (sb.framing !== 'full-app') {
    warnings.push('no outro: an end card with the product name helps viewers remember what they saw');
  }

  // Computed even with errors so `render --force` still gets a usable length.
  const total = engine.buildTimeline({
    steps: steps.map((step) => ({ duration: Number.isFinite(step.duration) && step.duration > 0 ? step.duration : 0 })),
    outro: isObject(sb.outro) ? { duration: Number.isFinite(sb.outro.duration) ? sb.outro.duration : undefined } : null
  }).total;
  if (!episode && total > LIMITS.totalWarn) warnings.push(`video runs ${total.toFixed(1)}s; consider splitting this clip or using episode format`);
  return { errors, warnings, total };
}

/**
 * Assemble the self-contained player page for a storyboard.
 * @param {{sb: object, dir: string, scenesHtml: string}} loaded result of loadStoryboard
 * @param {{play?: boolean, fps?: number}} options play adds playback; fps is the renderer's effective frame rate
 * @returns {string} HTML
 */
export function buildPage(loaded, { play = false, fps } = {}) {
  const { sb, dir, scenesHtml } = loaded;
  const template = readFileSync(join(ASSETS, 'player.html'), 'utf8');
  const engineSource = readFileSync(join(ASSETS, 'engine.js'), 'utf8');
  const theme = sb.theme || {};
  const themeCss = [
    theme.accent && `--ev-accent: ${theme.accent};`,
    theme.glow && `--ev-glow: ${theme.glow};`,
    theme.background && `--ev-bg: ${theme.background};`,
    theme.font && `--ev-font: ${theme.font};`,
    theme.mono && `--ev-mono: ${theme.mono};`
  ].filter(Boolean).join(' ');
  // Inline JSON must not be able to close the script element.
  const data = JSON.stringify(fps == null ? sb : { ...sb, fps }).replace(/</g, '\\u003c');
  const escapeText = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
  const replacements = {
    __BASE__: pathToFileURL(dir + '/').href,
    __TITLE__: escapeText(sb.title || 'Explainer video'),
    __THEME__: themeCss.replace(/[<>{}]/g, ''),
    __W__: String(sb.width || 1920),
    __H__: String(sb.height || 1080),
    __PROGRESS__: play ? '<div id="ev-progress"></div>' : '',
    __SCENES__: scenesHtml,
    __ENGINE__: engineSource,
    __DATA__: data,
    __PLAY__: play ? 'true' : 'false'
  };
  // One pass so a token that appears inside user content is never expanded.
  return template.replace(/__(BASE|TITLE|THEME|W|H|PROGRESS|SCENES|ENGINE|DATA|PLAY)__/g, (token) => replacements[token]);
}

export { engine };
