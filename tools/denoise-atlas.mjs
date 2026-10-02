import fs from 'node:fs';

/**
 * Post-process denoising for a baked lightmap.
 *
 * ## Why this exists at all
 *
 * Blender's Cycles denoiser does not apply to bakes. The bake operator exposes
 * no `use_denoising` property — verified, not assumed: `scene.render.bake` has
 * no such attribute on Blender 5.2, so setting `scene.cycles.use_denoising` has
 * no effect on a bake at all. A measured A/B confirms it, with grain falling
 * cleanly as samples rise and the denoiser switch changing nothing.
 *
 * So the noise has to be dealt with here, on the float buffer, before packing.
 *
 * ## Why bilateral rather than gaussian
 *
 * A plain blur trades noise for detail uniformly: it would soften the contact
 * shadows and the falloff under a lamp exactly as much as it softened grain. A
 * bilateral filter weights neighbours by *both* distance and similarity, so it
 * averages freely across a flat noisy region but barely at all across a step
 * change. That is the property that matters for a lightmap, where genuine
 * features are smooth gradients and hard shadow edges.
 *
 * ## Why the coverage mask
 *
 * The filter must not average across island boundaries. Two islands packed
 * beside each other are unrelated surfaces — one might be an interior wall and
 * the other the outside of the same wall — so mixing them would bleed light
 * across a seam. Normalised convolution against a coverage mask handles this:
 * blur `value x mask` and `mask` with the same kernel and divide, which
 * reweights the result to use only neighbours that belong to the same island.
 */

/* ── Coverage mask from the UV triangles ──────────────────────── */

/**
 * Rasterise the UV triangles into a coverage mask.
 *
 * The atlas itself cannot tell us where the islands are — a black texel could
 * be unlit geometry or empty space — so the mask has to come from the UVs,
 * which is the same information the bake used to decide what to write.
 *
 * @param {Float32Array} uv  per face corner, in face order: [u,v] x 3 per triangle
 * @param {number} triangles
 * @param {number} size      atlas edge in texels
 * @returns {Uint8Array}     1 where a texel is covered
 */
export function buildCoverageMask(uv, triangles, size) {
  const mask = new Uint8Array(size * size);

  for (let t = 0; t < triangles; t++) {
    const a = t * 6;

    // UV -> pixel space.
    const x0 = uv[a] * size;
    const y0 = uv[a + 1] * size;
    const x1 = uv[a + 2] * size;
    const y1 = uv[a + 3] * size;
    const x2 = uv[a + 4] * size;
    const y2 = uv[a + 5] * size;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1);
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - 1);
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)) + 1);

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;

    for (let py = minY; py <= maxY; py++) {
      const sy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;

        const w0 = ((x1 - x0) * (sy - y0) - (sx - x0) * (y1 - y0)) * inv;
        if (w0 < -1e-6 || w0 > 1 + 1e-6) continue;
        const w1 = ((sx - x0) * (y2 - y0) - (x2 - x0) * (sy - y0)) * inv;
        if (w1 < -1e-6 || w1 > 1 + 1e-6) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -1e-6 || w2 > 1 + 1e-6) continue;

        mask[py * size + px] = 1;
      }
    }
  }

  return mask;
}

/* ── Bilateral filter ─────────────────────────────────────────── */

/**
 * @param {Float32Array} pixels  RGBA float, atlas-sized
 * @param {Uint8Array} mask      coverage; texels outside it are untouched
 * @param {number} size
 * @param {{radius?: number, sigmaSpace?: number, sigmaRange?: number, passes?: number}} opts
 * @returns {{data: Float32Array, stats: object}}
 */
export function denoiseBilateral(pixels, mask, size, opts = {}) {
  const radius = opts.radius ?? 3;
  const sigmaSpace = opts.sigmaSpace ?? Math.max(0.8, radius * 0.5);
  // The range sigma is in irradiance units, so it has to scale with the scene's
  // brightness rather than being an absolute constant. It is derived from the
  // 95th percentile of lit values so a single hot texel cannot set it.
  const passes = opts.passes ?? 1;

  const count = size * size;

  // Luminance once, reused for both weighting and statistics.
  const lum = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    lum[i] = 0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2];
  }

  let sigmaRange = opts.sigmaRange ?? 0;
  if (!(sigmaRange > 0)) {
    const lit = [];
    for (let i = 0; i < count; i++) if (mask[i] && lum[i] > 1e-4) lit.push(lum[i]);
    lit.sort((a, b) => a - b);
    const p95 = lit.length ? lit[Math.floor(lit.length * 0.95)] : 1;
    // A fifth of the 95th percentile: large enough to average normal grain,
    // small enough that a real shadow edge (a much bigger step) is not crossed.
    sigmaRange = Math.max(p95 * 0.2, 1e-3);
  }

  // Spatial weights, precomputed.
  const weights = new Float32Array((radius * 2 + 1) * (radius * 2 + 1));
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      weights[(dy + radius) * (radius * 2 + 1) + (dx + radius)] = Math.exp(
        -d2 / (2 * sigmaSpace * sigmaSpace)
      );
    }
  }

  const rangeScale = 1 / (2 * sigmaRange * sigmaRange);
  let data = pixels;

  const before = meanSecondDifference(lum, mask, size);

  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(data.length);
    const outLum = new Float32Array(count);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const o = i * 4;

        if (!mask[i]) {
          out[o] = data[o];
          out[o + 1] = data[o + 1];
          out[o + 2] = data[o + 2];
          out[o + 3] = data[o + 3];
          outLum[i] = lum[i];
          continue;
        }

        const centre = lum[i];
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumW = 0;

        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= size) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= size) continue;

            const j = ny * size + nx;
            // Neighbours outside the island are excluded outright, which is
            // what stops light bleeding across a seam.
            if (!mask[j]) continue;

            const spatial = weights[(dy + radius) * (radius * 2 + 1) + (dx + radius)];
            const diff = lum[j] - centre;
            const w = spatial * Math.exp(-diff * diff * rangeScale);
            if (w < 1e-6) continue;

            const jo = j * 4;
            sumR += data[jo] * w;
            sumG += data[jo + 1] * w;
            sumB += data[jo + 2] * w;
            sumW += w;
          }
        }

        if (sumW <= 0) {
          out[o] = data[o];
          out[o + 1] = data[o + 1];
          out[o + 2] = data[o + 2];
          out[o + 3] = data[o + 3];
          outLum[i] = centre;
          continue;
        }

        out[o] = sumR / sumW;
        out[o + 1] = sumG / sumW;
        out[o + 2] = sumB / sumW;
        out[o + 3] = data[o + 3];
        outLum[i] = 0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2];
      }
    }

    data = out;
    lum.set(outLum);
  }

  const after = meanSecondDifference(lum, mask, size);

  // How much of the original detail survives, measured at the strongest edges.
  // If this collapses, the filter is smoothing real features rather than grain.
  const edgeRetention = measureEdgeRetention(pixels, data, mask, size);

  return {
    data,
    stats: {
      radius,
      sigmaSpace,
      sigmaRange,
      passes,
      noiseBefore: before,
      noiseAfter: after,
      reduction: before > 0 ? 1 - after / before : 0,
      edgeRetention,
    },
  };
}

/** Mean |value - mean(4 neighbours)| over covered texels, excluding edges. */
function meanSecondDifference(lum, mask, size) {
  let sum = 0;
  let n = 0;

  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      if (!mask[i]) continue;

      const c = lum[i];
      const l = lum[i - 1];
      const r = lum[i + 1];
      const u = lum[i - size];
      const d = lum[i + size];
      if (!mask[i - 1] || !mask[i + 1] || !mask[i - size] || !mask[i + size]) continue;
      if (l < 1e-6 || r < 1e-6 || u < 1e-6 || d < 1e-6) continue;

      const mean = (l + r + u + d) / 4;
      // Skip genuine discontinuities, which are not noise.
      const ratio = Math.max(c, mean) / Math.max(Math.min(c, mean), 1e-6);
      if (ratio > 4) continue;

      sum += Math.abs(c - mean);
      n++;
    }
  }

  return n ? sum / n : 0;
}

/**
 * Ratio of gradient magnitude after to before, at the strongest edges.
 *
 * Preserving edges is the whole reason for choosing a bilateral filter, so this
 * is the number that says whether that choice paid off: near 1 means real
 * features survived, well below 1 means the filter is blurring them away.
 */
function measureEdgeRetention(before, after, mask, size) {
  let kept = 0;
  let original = 0;

  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      if (!mask[i] || !mask[i + 1]) continue;

      const b0 = before[i * 4];
      const b1 = before[(i + 1) * 4];
      const a0 = after[i * 4];
      const a1 = after[(i + 1) * 4];

      const gb = Math.abs(b1 - b0);
      if (gb < 0.5) continue; // only look at strong edges

      original += gb;
      kept += Math.abs(a1 - a0);
    }
  }

  return original > 0 ? kept / original : 1;
}
