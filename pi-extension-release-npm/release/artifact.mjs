import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function paxFields(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.subarray(offset, space).toString());
    if (space < 0 || !Number.isInteger(length) || length <= 0 || offset + length > bytes.length) throw new Error('Invalid tar PAX header');
    const entry = bytes.subarray(space + 1, offset + length - 1).toString();
    const equals = entry.indexOf('=');
    fields[entry.slice(0, equals)] = entry.slice(equals + 1);
    offset += length;
  }
  return fields;
}

export async function artifact(file) {
  const compressed = await readFile(file);
  const tar = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let manifest;
  let pax = {}, globalPax = {}, longName;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const size = parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar entry size');
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const type = string(156, 1);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxFields(body); continue; }
    if (type === 'g') { globalPax = { ...globalPax, ...paxFields(body) }; continue; }
    if (type === 'L') { longName = body.toString().replace(/\0.*$/s, '').replace(/\n$/, ''); continue; }
    const prefix = string(345, 155);
    const name = pax.path ?? globalPax.path ?? longName ?? (prefix ? `${prefix}/` : '') + string(0, 100);
    pax = {}; longName = undefined;
    if (type === '5') continue;
    if (type && type !== '0') throw new Error(`Unsupported tar entry type ${type}: ${name}`);
    if (!name.startsWith('package/') || name.split('/').includes('..') || name.includes('\\')) throw new Error(`Unsafe tar entry: ${name}`);
    const relative = name.slice(8);
    if (files.has(relative)) throw new Error(`Duplicate tar entry: ${name}`);
    let content = body;
    if (relative === 'package.json') {
      manifest = JSON.parse(body.toString());
      const { version, ...normalized } = manifest;
      content = Buffer.from(JSON.stringify(stable(normalized)));
    }
    files.set(relative, { bytes: content, executable: Boolean(parseInt(string(100, 8), 8) & 0o111) });
  }
  if (!files.has('package.json')) throw new Error('Packed artifact has no package.json');
  return { compressed, files, manifest };
}

export function equalArtifacts(a, b) {
  if (a.files.size !== b.files.size) return false;
  for (const [name, file] of a.files) {
    const other = b.files.get(name);
    if (!other || file.executable !== other.executable || !file.bytes.equals(other.bytes)) return false;
  }
  return true;
}

export function checkIntegrity(bytes, dist) {
  if (dist?.integrity) {
    const choices = dist.integrity.split(/\s+/).map(item => item.split('-'));
    const supported = choices.filter(([algorithm]) => ['sha512', 'sha384', 'sha256', 'sha1'].includes(algorithm));
    if (!supported.length || !supported.some(([algorithm, digest]) => createHash(algorithm).update(bytes).digest('base64') === digest)) {
      throw new Error('Registry tarball integrity mismatch');
    }
  } else if (dist?.shasum && createHash('sha1').update(bytes).digest('hex') !== dist.shasum) {
    throw new Error('Registry tarball checksum mismatch');
  }
}
