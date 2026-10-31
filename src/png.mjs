import { deflateSync, inflateSync } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Minimal PNG encoder: RGBA8, filter 0, no interlace.
 * Enough to build deterministic fixtures without any dependency.
 */
export function encodePng({ width, height, rgba }) {
  if (rgba.length !== width * height * 4) throw new Error("rgba length does not match width*height*4");
  const source = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    source.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Palette PNG (color type 3, 8-bit indices). Only used by tests and fixtures to
 * exercise the decoder's palette path.
 */
export function encodeIndexedPng({ width, height, indices, palette }) {
  if (indices.length !== width * height) throw new Error("indices length does not match width*height");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;

  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    Buffer.from(indices).copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file");
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      let value = src[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter type ${filter}`);
      }
      row[x] = value & 0xff;
    }
  }
  return out;
}

/**
 * Decode a PNG to RGBA8. Returns { ok: false, reason } instead of throwing when
 * the format is valid but outside the implemented subset, so callers can mark
 * checks as SKIP rather than pretending they passed.
 */
export function decodePng(buf) {
  let chunks;
  try {
    chunks = readChunks(buf);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) return { ok: false, reason: "PNG has no IHDR chunk" };

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (interlace !== 0) return { ok: false, reason: "interlaced PNG is not supported" };
  if (bitDepth !== 8) return { ok: false, reason: `bit depth ${bitDepth} is not supported (8 only)` };
  if (![0, 2, 3, 4, 6].includes(colorType)) {
    return { ok: false, reason: `color type ${colorType} is not supported` };
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));

  let raw;
  try {
    raw = inflateSync(idat);
  } catch (error) {
    return { ok: false, reason: `corrupt image data: ${error.message}` };
  }

  const expected = (width * channels + 1) * height;
  if (raw.length < expected) {
    return { ok: false, reason: `truncated image data (${raw.length} of ${expected} bytes)` };
  }

  let samples;
  try {
    samples = unfilter(raw, width, height, channels);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const palette = chunks.find((c) => c.type === "PLTE")?.data ?? null;
  const transparency = chunks.find((c) => c.type === "tRNS")?.data ?? null;
  if (colorType === 3 && !palette) return { ok: false, reason: "palette PNG without PLTE chunk" };

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0) {
      r = g = b = samples[s];
    } else if (colorType === 4) {
      r = g = b = samples[s];
      a = samples[s + 1];
    } else if (colorType === 2) {
      r = samples[s];
      g = samples[s + 1];
      b = samples[s + 2];
    } else if (colorType === 6) {
      r = samples[s];
      g = samples[s + 1];
      b = samples[s + 2];
      a = samples[s + 3];
    } else {
      const index = samples[s];
      if (index * 3 + 2 >= palette.length) {
        return { ok: false, reason: `palette index ${index} out of range` };
      }
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      if (transparency && index < transparency.length) a = transparency[index];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }

  return { ok: true, width, height, bitDepth, colorType, rgba };
}
