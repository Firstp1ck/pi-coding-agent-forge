// Shot contact sheets: one labeled tile per step at its reading hold, paginated so no
// shot is dropped. Frames come from the browser (render.mjs) or from the decoded delivery
// MP4 (assemble.mjs); the browser lays out the tiles so labels need no ffmpeg text filter.
import { writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engine } from './storyboard.mjs';
import { firstFrameAt } from './layout.mjs';

export const SHEET = { columns: 4, tileWidth: 480, labelHeight: 34, gap: 6, rowsPerPage: 8 };

/** Shot timestamp label, minutes:seconds with hundredths: 0:07.40, 12:03.00. */
export function shotClock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Choose one frame per step that shows the step settled and readable.
 * Section card: the middle of the frames where the card is fully on and the black layer is off.
 * Ordinary step: the last frame where the step is fully visible and its caption, if any, is
 * fully shown, which also shows the step's final state. Falls back to the step's middle frame.
 * @param {object} sb storyboard
 * @param {object[]} samples inspect results for frames 0..n-1
 * @returns {{step: number, frame: number, time: number, label: string}[]} step is 1-based
 */
export function holdFrames(sb, samples, fps) {
  const timeline = engine.buildTimeline(sb);
  const last = samples.length - 1;
  return timeline.steps.map((seg, i) => {
    const lo = Math.min(last, firstFrameAt(seg.start, fps));
    const hi = Math.max(lo, Math.min(last, firstFrameAt(seg.end, fps) - 1));
    const def = sb.steps[i];
    const settled = [];
    for (let k = lo; k <= hi; k++) {
      const r = samples[k];
      if (def.section) {
        if (r.section?.step === i && r.section.opacity >= 0.99 && r.section.black <= 0.01) settled.push(k);
      } else if (r.step === i && r.opacity >= 0.99 && (!def.caption || (r.caption && r.caption.opacity >= 0.99))) {
        settled.push(k);
      }
    }
    let frame;
    if (!settled.length) frame = Math.round((lo + hi) / 2);
    else if (def.section) frame = settled[Math.floor((settled.length - 1) / 2)];
    else frame = settled[settled.length - 1];
    const title = def.section ? def.section.title : [def.caption?.bold, def.caption?.rest].filter(Boolean).join(' ');
    const kind = def.section ? `${def.section.kind}: ` : '';
    return { step: i + 1, frame, time: frame / fps, label: `${i + 1} · ${shotClock(frame / fps)} · ${kind}${title || 'untitled'}` };
  });
}

/** Paths for each sheet page: page 1 at `path`, later pages at name-p2.png, name-p3.png, ... */
export function sheetPaths(path, pages) {
  const ext = extname(path) || '.png';
  const stem = join(dirname(path), basename(path, extname(path)));
  return Array.from({ length: pages }, (_, i) => (i === 0 ? path : `${stem}-p${i + 1}${ext}`));
}

export function pageCount(shots) {
  return Math.max(1, Math.ceil(shots / (SHEET.columns * SHEET.rowsPerPage)));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Sheet page HTML for tiles [{image (absolute path), label}] and its pixel size. */
function sheetPage(tiles, width, height) {
  const { columns, tileWidth, labelHeight, gap } = SHEET;
  const imageHeight = Math.round((tileWidth * height) / width);
  const rows = Math.ceil(tiles.length / columns);
  const size = { width: columns * tileWidth + (columns + 1) * gap, height: rows * (imageHeight + labelHeight) + (rows + 1) * gap };
  const cells = tiles.map((t) => `<figure><img src="${escapeHtml(pathToFileURL(t.image).href)}"><figcaption>${escapeHtml(t.label)}</figcaption></figure>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: #222; }
body { width: ${size.width}px; height: ${size.height}px; display: grid; grid-template-columns: repeat(${columns}, ${tileWidth}px);
  grid-auto-rows: ${imageHeight + labelHeight}px; gap: ${gap}px; padding: ${gap}px; box-sizing: border-box; align-content: start; }
figure { margin: 0; width: ${tileWidth}px; }
img { display: block; width: ${tileWidth}px; height: ${imageHeight}px; }
figcaption { height: ${labelHeight}px; line-height: ${labelHeight}px; padding: 0 8px; font: 600 16px 'Noto Sans', 'DejaVu Sans', Arial, sans-serif;
  color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body>${cells}</body></html>`;
  return { html, size };
}

/**
 * Lay out labeled tiles into sheet pages with the browser and write them as PNGs.
 * @param {object} session browser session from openBrowser
 * @param {{image: string, label: string}[]} tiles frame PNG paths and labels, in shot order
 * @param {string[]} outputs one path per page, from sheetPaths
 * @param {string} work scratch directory for the page HTML
 */
export async function composeSheets(session, tiles, outputs, { width, height, work }) {
  const perPage = SHEET.columns * SHEET.rowsPerPage;
  for (let p = 0; p < outputs.length; p++) {
    const { html, size } = sheetPage(tiles.slice(p * perPage, (p + 1) * perPage), width, height);
    const page = join(work, `sheet-page-${p + 1}.html`);
    writeFileSync(page, html);
    await session.setSize(size.width, size.height);
    await session.navigate(pathToFileURL(page).href);
    const broken = await session.evaluate('Array.from(document.images).filter(function (i) { return !i.naturalWidth; }).length');
    if (broken) throw new Error(`contact sheet page ${p + 1}: ${broken} frame image(s) failed to load`);
    writeFileSync(outputs[p], await session.screenshot());
  }
}
