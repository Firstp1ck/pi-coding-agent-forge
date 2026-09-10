function quotePrefix(value, maxDepth = Infinity) {
  let length = 0;
  for (let depth = 0; depth < maxDepth; depth++) {
    const part = value.slice(length).match(/^ {0,3}>[\t ]?/);
    if (!part) break;
    length += part[0].length;
  }
  return value.slice(0, length);
}

const referenceKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase();

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
  let listIndent = 0;
  let listQuoteDepth = 0;
  const definitions = [];
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
    let prefix = quotePrefix(value, fence?.quoteDepth);
    let quoteDepth = (prefix.match(/>/g) ?? []).length;
    let content = value.slice(prefix.length);
    let indentation = content.match(/^ */)[0].length;
    if (fence && (quoteDepth !== fence.quoteDepth
      || (content.trim() && indentation < fence.indent))) {
      fence = null;
      prefix = quotePrefix(value);
      quoteDepth = (prefix.match(/>/g) ?? []).length;
      content = value.slice(prefix.length);
      indentation = content.match(/^ */)[0].length;
    }
    // Quote prefixes are whitespace, not hidden code, so soft wraps still match.
    for (let j = 0; j < prefix.length; j++) chars[line.index + j] = ' ';
    if (fence) {
      hide(line.index, line.index + value.length);
      const close = content.slice(fence.indent).match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (quoteDepth !== listQuoteDepth || (content.trim() && indentation < listIndent)) listIndent = 0;
    listQuoteDepth = quoteDepth;
    const marker = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[\t ]+/)?.[0];
    if (marker) listIndent = marker.length;
    const block = content.slice(marker ? marker.length : listIndent);
    const open = block.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length, quoteDepth, indent: listIndent };
      hide(line.index, line.index + value.length);
    } else if (/^(?: {4}|\t)/.test(content)) {
      hide(line.index, line.index + value.length);
    } else {
      const definition = content.match(/^ {0,3}\[([^\]\n]{1,999})\]:[\t ]*\S[^\n]*$/);
      if (definition) definitions.push({ start: line.index + prefix.length, end: line.index + value.length, label: definition[1] });
    }
  }
  let masked = chars.join('');
  // Process comments and same-line code spans in source order. A delimiter in
  // an already consumed span cannot open a different Markdown construct.
  const codeEnds = new Map();
  for (const line of masked.matchAll(/[^\r\n]+/g)) {
    const runs = [...line[0].matchAll(/`+/g)];
    const nextByLength = new Map();
    for (let i = runs.length - 1; i >= 0; i--) {
      const length = runs[i][0].length;
      if (nextByLength.has(length)) codeEnds.set(line.index + runs[i].index, nextByLength.get(length));
      nextByLength.set(length, line.index + runs[i].index + length);
    }
  }
  let consumed = 0;
  for (const token of masked.matchAll(/<!--|`+/g)) {
    if (token.index < consumed) continue;
    if (token[0] === '<!--') {
      const close = masked.indexOf('-->', token.index + 4);
      consumed = close === -1 ? masked.length : close + 3;
    } else {
      const end = codeEnds.get(token.index);
      if (end === undefined) continue;
      consumed = end;
    }
    hide(token.index, consumed);
  }
  masked = chars.join('');
  const references = new Set();
  for (const definition of definitions) {
    if (masked.slice(definition.start, definition.end).includes('\0')) continue;
    references.add(referenceKey(definition.label));
    hide(definition.start, definition.end);
  }
  masked = chars.join('');
  // A resolved full reference link displays its first label, not its ID.
  for (const m of masked.matchAll(/\[([^\[\]\n\0]+)\]\[([^\[\]\n\0]{1,999})\]/g)) {
    if (references.has(referenceKey(m[2]))) {
      const start = m.index + m[1].length + 2;
      hide(start, m.index + m[0].length);
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
  // Check tag syntax rather than treating mathematical comparisons as HTML.
  const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>`]+))?)*[\t ]*\/?>$/;
  const autolink = /^<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[a-z0-9.-]+)>$/i;
  for (const m of masked.matchAll(/<[^<>\n\0]{1,2048}>/g)) {
    if (tag.test(m[0]) || autolink.test(m[0])) hide(m.index, m.index + m[0].length);
  }
  for (const m of masked.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>\0]+/gi)) hide(m.index, m.index + m[0].length);
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

export function splitSentences(masked, words, source = masked, format = 'markdown') {
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
  if (format === 'markdown') {
    let previousQuoteDepth = 0;
    for (const line of masked.matchAll(/[^\n]*(?:\n|$)/g)) {
      const original = source.slice(line.index, line.index + line[0].length);
      const prefix = quotePrefix(original);
      const quoteDepth = (prefix.match(/>/g) ?? []).length;
      const content = line[0].slice(prefix.length);
      if (quoteDepth && quoteDepth !== previousQuoteDepth) boundaries.add(line.index);
      if (quoteDepth || !content.trim()) previousQuoteDepth = quoteDepth;
      if (/^ {0,3}(?:#{1,6}[\t ]+|[-+*][\t ]+|\d+[.)][\t ]+)/.test(content)) {
        boundaries.add(line.index);
        if (/^ {0,3}#{1,6}[\t ]/.test(content)) boundaries.add(line.index + line[0].length);
      }
    }
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
