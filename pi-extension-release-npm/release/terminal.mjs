import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';

const FINAL = new Set(['unchanged', 'skipped', 'published', 'processing', 'failed', 'blocked', 'cancelled']);
const ERRORS = new Set(['failed', 'blocked', 'cancelled']);
const FILTERS = ['all', 'changed', 'errors'];
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function safeText(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
}

// Keep emoji/combining sequences intact and conservatively bound terminal cells.
export function fitText(value, width, pad = false) {
  let text = '', used = 0;
  for (const { segment } of graphemes.segment(safeText(value))) {
    let size = /[0-9#*]\ufe0f?\u20e3/u.test(segment) ? 2 : 0;
    for (const character of segment) {
      const point = character.codePointAt(0);
      const zeroWidth = /\p{Mark}/u.test(character) || point === 0x200d;
      const wide = point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
        || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
        || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
        || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
        || point >= 0x1f000) || /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(character);
      size = Math.max(size, zeroWidth ? 0 : wide ? 2 : 1);
    }
    if (used + size > width) break;
    text += segment;
    used += size;
  }
  return text + (pad ? ' '.repeat(Math.max(0, width - used)) : '');
}

export function logTail(file, limit = 65536) {
  if (!file) return ['No log available yet.'];
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (size > limit) lines.shift();
    return lines.map(safeText);
  } catch (error) { return [`Log unavailable: ${safeText(error.message)}`]; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export class ReleaseTerminal {
  constructor({ input, output, onAbort, mode, now = Date.now }) {
    Object.assign(this, { input, output, onAbort, mode, now });
    this.records = new Map();
    this.started = now();
    this.selected = 0;
    this.filter = 'all';
    this.details = false;
    this.key = (text, key) => {
      if (text?.includes('\x03') || key?.sequence?.includes('\x03')) this.onAbort();
      else this.handleKey(key ?? {});
    };
    this.resize = () => this.draw();
  }

  start() {
    this.previousRaw = this.input.isRaw ?? false;
    this.previousFlowing = this.input.readableFlowing === true;
    this.active = true;
    try {
      emitKeypressEvents(this.input);
      this.input.setRawMode(true);
      this.input.on('keypress', this.key);
      this.output.on('resize', this.resize);
      this.input.resume();
      this.output.write('\x1b[?1049h\x1b[?25l');
      this.timer = setInterval(() => this.draw(), 100);
      this.draw();
    } catch (error) { this.close(); throw error; }
  }

  update(event) {
    const previous = this.records.get(event.target);
    const done = FINAL.has(event.status) || event.status === 'ready' && this.mode !== 'publish';
    this.records.set(event.target, { ...event, started: previous?.started ?? this.now(), finished: done ? this.now() : undefined });
  }

  visible() {
    return [...this.records.values()].filter(record => this.filter === 'all'
      || this.filter === 'errors' && ERRORS.has(record.status)
      || this.filter === 'changed' && (['publish-first', 'publish-update'].includes(record.action) || ERRORS.has(record.status)));
  }

  handleKey(key) {
    if (key.ctrl && key.name === 'c') { this.onAbort(); return; }
    if (key.name === 'escape' || key.name === 'q') this.details = false;
    else if (key.name === 'return') this.details = !this.details;
    else if (key.name === 'f' || ['a', 'c', 'e'].includes(key.name)) {
      this.filter = key.name === 'f' ? FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length] : { a: 'all', c: 'changed', e: 'errors' }[key.name];
      this.selected = 0;
      this.details = false;
    } else {
      const page = Math.max(1, (this.output.rows ?? 24) - 5);
      if (key.name === 'up') this.selected--;
      if (key.name === 'down') this.selected++;
      if (key.name === 'pageup') this.selected -= page;
      if (key.name === 'pagedown') this.selected += page;
      if (key.name === 'home') this.selected = 0;
      if (key.name === 'end') this.selected = this.visible().length - 1;
    }
    this.draw();
  }

  frame() {
    const width = Math.max(1, this.output.columns ?? 100);
    const height = Math.max(1, this.output.rows ?? 24);
    const records = this.visible();
    this.selected = Math.max(0, Math.min(this.selected, records.length - 1));
    const elapsed = Math.floor((this.now() - this.started) / 1000);
    const counts = new Map();
    for (const record of this.records.values()) counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
    const counters = [...counts].map(([status, count]) => `${status} ${count}`).join(' | ');
    const lines = [`Release ${this.mode} | ${elapsed}s | ${this.records.size} packages | ${counters}`];
    const capacity = Math.max(0, height - 4);
    const record = records[this.selected];
    if (this.details && record) {
      lines.push(`Details: ${record.name ?? record.target} | ${record.status} | ${record.stage}`);
      lines.push(safeText(record.detail));
      lines.push(...logTail(record.logPath).slice(-capacity));
    } else {
      const nameWidth = Math.max(8, Math.min(46, width - 55));
      const cell = (value, length) => fitText(value, length, true);
      lines.push(`  ${cell('Package', nameWidth)} ${cell('Version', 12)} ${cell('Stage', 10)} ${cell('Result', 10)} Elapsed`);
      const offset = capacity ? Math.floor(this.selected / capacity) * capacity : 0;
      for (const [index, item] of records.slice(offset, offset + capacity).entries()) {
        const seconds = Math.floor(((item.finished ?? this.now()) - item.started) / 1000);
        lines.push(`${offset + index === this.selected ? '>' : ' '} ${cell(item.name ?? item.target, nameWidth)} ${cell(item.version ?? '-', 12)} ${cell(item.stage, 10)} ${cell(item.status, 10)} ${seconds}s`);
      }
      if (!records.length && capacity) lines.push('Waiting for packages matching this filter...');
    }
    const footer = `[${this.filter}] ${records.length ? this.selected + 1 : 0}/${records.length} | arrows PgUp/PgDn Home/End | f filter | Enter details | Esc back | Ctrl+C abort`;
    const body = lines.slice(0, Math.max(0, height - 1));
    while (body.length < height - 1) body.push('');
    body.push(footer);
    return body.map(line => fitText(line, Math.max(0, width - 1)));
  }

  draw() {
    if (!this.active) return;
    this.output.write(this.frame().map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line}`).join(''));
  }

  finish(records) {
    for (const record of records) this.update(record);
    this.draw();
    this.close();
  }

  close() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.input.removeListener('keypress', this.key);
    this.output.removeListener('resize', this.resize);
    try { this.input.setRawMode(this.previousRaw); }
    finally {
      // A newly resumed TTY keeps Node alive even after its last key listener is removed.
      if (!this.previousFlowing) this.input.pause();
      this.output.write('\x1b[?25h\x1b[?1049l');
    }
  }
}
