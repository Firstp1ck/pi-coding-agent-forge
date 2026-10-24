/**
 * Minimal PNG reader used to validate screenshots (spec §5.5 step 5: the PNG
 * decodes, has the expected size, and is not one uniform colour). Supports
 * non-interlaced images of every colour type at bit depths 1–16.
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

export interface DecodedPng extends PngHeader {
  /** RGB, 3 bytes per pixel, row-major (alpha dropped). */
  rgb: Buffer;
}

/** Reads the IHDR chunk. @throws Error when `data` is not a PNG. */
export function readPngHeader(data: Buffer): PngHeader {
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("not a PNG image");
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
    interlace: data[28],
  };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG to RGB. @throws Error for malformed or interlaced images. */
export function decodePng(data: Buffer): DecodedPng {
  const header = readPngHeader(data);
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;
  for (let offset = 8; offset + 8 <= data.length; ) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat.push(body);
    else if (type === "PLTE") palette = body;
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= bpp ? lines[dst + x - bpp] : 0;
      const up = y > 0 ? lines[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? lines[dst - stride + x - bpp] : 0;
      let out: number;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + ((left + up) >> 1);
      else if (filter === 4) out = value + paeth(left, up, upLeft);
      else throw new Error(`invalid PNG filter ${filter}`);
      lines[dst + x] = out & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  const sample = (row: number, index: number): number => {
    if (bitDepth === 8) return lines[row * stride + index];
    if (bitDepth === 16) return lines[row * stride + index * 2];
    const bitOffset = index * bitDepth;
    const byte = lines[row * stride + (bitOffset >> 3)];
    const shift = 8 - bitDepth - (bitOffset & 7);
    const value = (byte >> shift) & ((1 << bitDepth) - 1);
    return colorType === 3 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 3;
      const base = x * channels;
      if (colorType === 3) {
        const index = sample(y, base);
        if (!palette || index * 3 + 2 >= palette.length) throw new Error("PNG palette index out of range");
        palette.copy(rgb, out, index * 3, index * 3 + 3);
      } else if (channels >= 3) {
        rgb[out] = sample(y, base);
        rgb[out + 1] = sample(y, base + 1);
        rgb[out + 2] = sample(y, base + 2);
      } else {
        rgb.fill(sample(y, base), out, out + 3);
      }
    }
  }
  return { ...header, rgb };
}

/** `true` when every pixel has the same colour. */
export function isUniform(rgb: Buffer): boolean {
  for (let i = 3; i < rgb.length; i += 3) {
    if (rgb[i] !== rgb[0] || rgb[i + 1] !== rgb[1] || rgb[i + 2] !== rgb[2]) return false;
  }
  return true;
}
