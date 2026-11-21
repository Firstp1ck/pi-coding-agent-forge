import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const uploadIntegrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export const uploadReceiptPath = (cacheDir, registry, name) => path.join(cacheDir, 'uploads', `${createHash('sha256').update(`${registry}\0${name}`).digest('hex')}.json`);

export async function readUploadReceipt(file, registry, name) {
  let receipt;
  try { receipt = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Upload receipt is unreadable; inspect it before retrying publication'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schemaVersion !== 1 || receipt.registry !== registry || receipt.name !== name
    || !/^\d+\.\d+\.\d+$/.test(receipt.version) || !/^sha(?:512|1)-[A-Za-z0-9+/]+=*$/.test(receipt.integrity)
    || !['publish-first', 'publish-update'].includes(receipt.action)) throw new Error('Invalid upload receipt; inspect it before retrying publication');
  return receipt;
}

export async function saveUploadReceipt(file, receipt) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...receipt }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function matchesUpload(bytes, integrity) {
  const at = integrity.indexOf('-');
  return `${integrity.slice(0, at)}-${createHash(integrity.slice(0, at)).update(bytes).digest('base64')}` === integrity;
}
