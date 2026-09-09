// Mask excluded text without moving UTF-16 offsets in the original source.
export function maskProse(source, format) {
  if (format === 'text') return source;
  const chars = source.split('');
  const hide = (start, end) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = '\0';
    }
  };
  const lines = [...source.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0].length);
  let fence = null;
  let frontmatterEnd = -1;
  if (/^\uFEFF?---\s*$/.test(lines[0]?.[0].trimEnd() ?? '')) {
    frontmatterEnd = lines.findIndex((m, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(m[0].trimEnd()));
  }
  for (const [i, line] of lines.entries()) {
    const value = line[0].replace(/\r?\n$/, '');
    if (i <= frontmatterEnd) {
      hide(line.index, line.index + line[0].length);
      continue;
    }
    if (fence) {
      hide(line.index, line.index + value.length);
      const close = value.match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      hide(line.index, line.index + value.length);
    } else if (/^(?: {4}|\t)/.test(value) || /^ {0,3}\[[^\]]+\]:\s*/.test(value)) {
      hide(line.index, line.index + value.length);
    }
  }
  let masked = chars.join('');
  for (const m of masked.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) hide(m.index, m.index + m[0].length);
  masked = chars.join('');
  // Inline code uses equal-length delimiter runs on the same line.
  for (const line of masked.matchAll(/[^\r\n]+/g)) {
    const runs = [...line[0].matchAll(/`+/g)];
    const nextByLength = new Map();
    const closes = new Map();
    for (let i = runs.length - 1; i >= 0; i--) {
      const length = runs[i][0].length;
      if (nextByLength.has(length)) closes.set(i, nextByLength.get(length));
      nextByLength.set(length, i);
    }
    for (let i = 0; i < runs.length; i++) {
      if (!closes.has(i)) continue;
      const j = closes.get(i);
      hide(line.index + runs[i].index, line.index + runs[j].index + runs[j][0].length);
      i = j;
    }
  }
  masked = chars.join('');
  // Keep visible link labels. Bound destination scanning for malformed Markdown.
  for (const m of masked.matchAll(/\]\(/g)) {
    let depth = 1;
    const start = m.index + 1;
    for (let i = start + 1; i < Math.min(masked.length, start + 2048); i++) {
      if (masked[i] === '\n' || masked[i] === '\0') break;
      if (masked[i] === '\\') { i++; continue; }
      if (masked[i] === '(') depth++;
      if (masked[i] === ')' && --depth === 0) { hide(start, i + 1); break; }
    }
  }
  masked = chars.join('');
  for (const pattern of [/<[^>\n\0]{1,2048}>/g, /\b(?:https?:\/\/|www\.)[^\s<>\0]+/gi]) {
    for (const m of masked.matchAll(pattern)) hide(m.index, m.index + m[0].length);
  }
  return chars.join('');
}

export function normalize(text) {
  // ASCII folding avoids Unicode case expansions changing source offsets.
  return text.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, ' ');
}

export function tokenize(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*(?:-[\p{L}\p{N}]+)*/gu)]
    .map(m => ({ value: normalize(m[0]), start: m.index, end: m.index + m[0].length }));
}

export function splitSentences(masked, words) {
  const boundaries = new Set([masked.length]);
  const abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e']);
  for (const m of masked.matchAll(/[.!?]+["'’”\])]*(?=\s|\0|$)|\n[\t \r\0]*\n/g)) {
    if (m[0][0] === '.') {
      const before = masked.slice(Math.max(0, m.index - 12), m.index);
      const last = normalize(before.match(/[A-Za-z.]+$/)?.[0] ?? '');
      if (abbreviations.has(last) || /(?:^|\.)[A-Za-z]$/.test(last)) continue;
    }
    boundaries.add(m.index + m[0].length);
  }
  for (const m of masked.matchAll(/^ {0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s*)[^\n]*/gm)) {
    boundaries.add(m.index);
    if (/^ {0,3}#{1,6}\s/.test(m[0])) boundaries.add(m.index + m[0].length);
  }
  const sentences = [];
  let cursor = 0;
  for (const end of [...boundaries].sort((a, b) => a - b)) {
    const first = cursor;
    while (cursor < words.length && words[cursor].start < end) cursor++;
    if (cursor > first) {
      sentences.push({ start: words[first].start, end, words: words.slice(first, cursor) });
    }
  }
  return sentences;
}

export function locator(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return offset => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { offset, line: low + 1, column: offset - starts[low] + 1 };
  };
}
