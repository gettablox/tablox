/**
 * Generates Tablox's four static icon files: the manifest default.
 *
 * The live toolbar icon is drawn at runtime by the service worker, because the
 * count inside it changes; these files only exist so Chrome has something to
 * show in the split second before the first `setIcon` lands.
 *
 * The default is the Stable shape, which is the state a freshly-installed
 * extension will immediately paint over with the real count. The count itself is
 * Chrome's badge, so a static icon carries no number at all.
 *
 * Geometry comes from src/shared/shape-icon.js, so the default is pixel-
 * identical to what the service worker draws, and the colour comes from
 * src/shared/state.js so it cannot drift.
 *
 * Zero dependencies: PNGs are encoded with node:zlib. Run with `npm run icons`.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATES } from '../src/shared/state.js';
import { ICON_SIZES, renderShape } from '../src/shared/shape-icon.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'src', 'icons');

/** Matches the state a fresh install starts in. */
const DEFAULT_STATE = STATES[0];

function main() {
  mkdirSync(ICON_DIR, { recursive: true });

  for (const size of ICON_SIZES) {
    const { data, width, height } = renderShape({
      size,
      fill: DEFAULT_STATE.iconColor,
    });
    const png = encodePng(width, height, Buffer.from(data.buffer, data.byteOffset, data.length));
    writeFileSync(join(ICON_DIR, `icon-${size}.png`), png);
  }

  console.log(`Wrote ${ICON_SIZES.length} default icons to src/icons`);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Wrap data in a length-prefixed, CRC-suffixed PNG chunk.
 *
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

main();
