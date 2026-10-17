/**
 * imageQuality.js
 *
 * Tells a real NFT picture apart from an empty one, for the "Blanks"
 * switch (see HIDE-BLANKS-PLAN.md in the project docs). Moonlabs' picture
 * server has three kinds of broken pictures:
 *   - no picture at all (handled elsewhere: the download fails),
 *   - a plain white picture (all found so far are the same 480x640 file),
 *   - only the rarity background (grey/brown/yellow/red/purple, sometimes
 *     with a small element icon or stars in a corner), no item on it.
 *
 * How the check works: decode the PNG, then
 *   1. every pixel white            -> 'blank'
 *   2. in the centre area (10-90% of the width, 15-95% of the height,
 *      which leaves out the corner icons), count the near-black pixels
 *      (all three colour values below 45). Items and creatures are drawn
 *      with dark outlines; backgrounds have none. Under 0.4% -> 'blank'.
 * Tested on 11 Oct 2026 on 457 weapon/equipment pictures: empty ones had
 * 0%, real ones at least 1.7% - a clean gap.
 *
 * Pure JavaScript (fflate does the unzipping), so the phone app and the
 * website share it. Anything it can't read (not a PNG, unusual PNG
 * formats) counts as 'ok', so nothing is hidden by mistake.
 */
import { unzlibSync } from 'fflate';

const DARK_LEVEL = 45;
const MIN_DARK_SHARE = 0.004;

function readUint32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Decodes an 8-bit, non-interlaced PNG into { width, height, channels,
 *  pixels } (pixels as RGB(A) bytes, palette expanded to RGB), or null. */
export function decodePng(bytes) {
  if (!bytes || bytes.length < 33) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== sig[i]) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];
  let idatLength = 0;
  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = readUint32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLength += data.length;
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const bytesPerPixelByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bytesPerPixelByType[colorType];
  if (!bpp || (colorType === 3 && !palette)) return null;

  const compressed = new Uint8Array(idatLength);
  let offset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }
  let raw;
  try {
    raw = unzlibSync(compressed);
  } catch (e) {
    return { corrupt: true }; // the picture data itself is damaged
  }

  // Undo the per-row filters.
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return { corrupt: true }; // cut off
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let value;
      if (filter === 0) value = rawByte;
      else if (filter === 1) value = rawByte + left;
      else if (filter === 2) value = rawByte + up;
      else if (filter === 3) value = rawByte + ((left + up) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return null;
      out[dst + x] = value & 0xff;
    }
  }

  // Bring everything to RGB or RGBA so the checks below see colours.
  if (colorType === 2 || colorType === 6) return { width, height, channels: bpp, pixels: out };
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (colorType === 3) {
      const idx = out[i] * 3;
      rgb[i * 3] = palette[idx];
      rgb[i * 3 + 1] = palette[idx + 1];
      rgb[i * 3 + 2] = palette[idx + 2];
    } else {
      const g = out[i * bpp];
      rgb[i * 3] = g;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = g;
    }
  }
  return { width, height, channels: 3, pixels: rgb };
}

/** 'ok' or 'blank' for a picture's bytes (anything unreadable is 'ok'). */
// The first bytes every picture file of these kinds starts with.
function isPictureFile(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45;
  return png || jpeg || gif || webp;
}

export function judgeImageBytes(bytes) {
  // Moonlabs sometimes answers with something that isn't a picture at
  // all, or with a damaged one: the Hub then shows "Unavailable". Count
  // those as blank, so "Hide blanks" hides them too (Raphael, 17 Oct
  // 2026 - on the phone they stayed visible). Blank-marked pictures are
  // downloaded again later, so a fixed one comes back by itself.
  if (!isPictureFile(bytes)) return 'blank';
  const image = decodePng(bytes);
  if (image && image.corrupt) return 'blank';
  if (!image) return 'ok'; // a kind of picture this check can't read - leave it be
  const { width, height, channels, pixels } = image;

  let allWhite = true;
  for (let i = 0; i < pixels.length; i += channels) {
    if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
      allWhite = false;
      break;
    }
  }
  if (allWhite) return 'blank';

  const x0 = Math.floor(width * 0.1);
  const x1 = Math.floor(width * 0.9);
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.floor(height * 0.95);
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * channels;
      total += 1;
      if (pixels[i] < DARK_LEVEL && pixels[i + 1] < DARK_LEVEL && pixels[i + 2] < DARK_LEVEL) dark += 1;
    }
  }
  return total > 0 && dark / total < MIN_DARK_SHARE ? 'blank' : 'ok';
}
