import zlib from 'node:zlib';

/**
 * A minimal 8-bit RGB PNG encoder.
 *
 * ## Why not a library
 *
 * PNG's container is small and fully specified: a signature, three chunks, and
 * a zlib stream that Node already provides. Writing it here is ~80 lines and
 * avoids taking a dependency for one output format — and the format is stable
 * enough that this will not need maintaining.
 *
 * ## Why PNG rather than something exotic
 *
 * A lightmap is an image and this is an image format. It opens in any viewer,
 * browsers decode it natively into a GPU texture, and it is trivially
 * cache-busted by name. The previous custom binary container was none of those
 * things, which meant you could not look at the bake to diagnose it.
 *
 * ## What is deliberately not implemented
 *
 * Interlacing, palettes, 16-bit depth, and the Paeth/Sub/Up filters. Filter 0
 * (None) is used for every scanline: zlib already exploits the fact that
 * neighbouring texels are similar, and a smooth gradient compresses well
 * without per-scanline filtering. That keeps this short enough to trust.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);

  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * Encode 8-bit RGB pixels as a PNG.
 *
 * @param {Uint8Array} rgb      `width * height * 3` bytes, **row 0 first**
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePngRgb(rgb, width, height) {
  if (rgb.length !== width * height * 3) {
    throw new Error(
      `encodePngRgb: got ${rgb.length} bytes for ${width}x${height} RGB ` +
        `(expected ${width * height * 3})`
    );
  }

  // IHDR: width, height, bit depth 8, colour type 2 (truecolour), deflate,
  // filter method 0, no interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines, each prefixed with its filter byte.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0; // filter: None
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, at + 1);
  }

  // Level 9: this is a one-off offline step, so the extra time is free and the
  // file is a download.
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Transfer functions ───────────────────────────────────────── */

/**
 * Linear light → 8-bit, via the sRGB transfer function.
 *
 * Storing irradiance linearly in 8 bits would band badly in the dim regions:
 * most of this atlas sits well below 1.0 while the highlights reach ~22, so a
 * linear byte step near the bottom would be a large fraction of the value
 * there.
 *
 * The sRGB curve is the right answer rather than a plain square root, for two
 * reasons: it has a linear segment near zero that preserves deep shadow detail,
 * and it is **exactly** what the GPU inverts when a texture is tagged
 * `SRGBColorSpace`. Writing any other curve would leave a residue of error that
 * no amount of care elsewhere could remove.
 *
 * The value written is normalised by the atlas peak, which is stored in the
 * sidecar and multiplied back in via `lightMapIntensity` — so the texture
 * always spans its full range regardless of how bright the scene happens to be.
 */
export function encodeSrgb(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 255;
  const v = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

/** Inverse of `encodeSrgb`, for verifying what a round trip costs. */
export function decodeSrgb(byte) {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
