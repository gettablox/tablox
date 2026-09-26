/**
 * Icon tests.
 *
 * The icon is now a plain coloured square with softened corners, and the tab
 * count lives in Chrome's badge. That makes these tests about geometry rather
 * than typography: the shape must be the same silhouette in every state, it
 * must not carry any second colour, and it must fill as much of the canvas as
 * it can while keeping its anti-aliased edges off Chrome's clip boundary.
 *
 * The corner radius and the inset are re-derived here independently from the
 * renderer's own constants, so a bug in the geometry is caught rather than being
 * compared against itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATES, getState, contrastRatio, hexToRgb } from '../src/shared/state.js';
import {
  ICON_SIZES,
  TOOLBAR_ICON_SIZE,
  EDGE_INSET,
  CORNER_RATIO,
  ROUNDED_CORNERS,
  renderShape,
} from '../src/shared/shape-icon.js';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

/** Alpha at a pixel, 0-255. */
const alphaAt = (icon, x, y) => icon.data[(y * icon.width + x) * 4 + 3];

/** The distinct alpha values present in the icon, ascending. */
const alphasIn = (icon) => {
  const seen = new Set();
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) seen.add(alphaAt(icon, x, y));
  }
  return [...seen].sort((a, b) => a - b);
};

/** The bounding box of every pixel with any opacity. */
const inkBox = (icon) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      if (alphaAt(icon, x, y) === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

/** Every distinct RGB triple in the icon, ignoring alpha. */
const coloursIn = (icon) => {
  const seen = new Set();
  for (let i = 0; i < icon.width * icon.height; i += 1) {
    if (icon.data[i * 4 + 3] === 0) continue;
    seen.add(`${icon.data[i * 4]},${icon.data[i * 4 + 1]},${icon.data[i * 4 + 2]}`);
  }
  return [...seen];
};

// --- geometry -------------------------------------------------------------

test('the required sizes are the ones Chrome asks for', () => {
  assert.deepEqual([...ICON_SIZES], [16, 32, 48, 128]);
});

test('the toolbar icon is the 32px one Chrome actually receives', () => {
  assert.equal(TOOLBAR_ICON_SIZE, 32);
});

test('the shape is a square, the full size of the box it is given', () => {
  for (const size of ICON_SIZES) {
    const icon = renderShape({ size, fill: '#19DF96' });
    assert.equal(icon.width, size, `${size}px icon is not ${size} wide`);
    assert.equal(icon.height, size, `${size}px icon is not ${size} tall`);

    const box = inkBox(icon);
    const side = size - 2 * EDGE_INSET;
    assert.equal(box.width, side, `${size}px icon spans ${box.width}px, expected ${side}`);
    assert.equal(box.height, side, `${size}px icon spans ${box.height}px, expected ${side}`);
  }
});

test('every corner of the box is rounded', () => {
  assert.equal(ROUNDED_CORNERS.length, 4, 'all four corners are rounded');

  const combos = ROUNDED_CORNERS.map(([x, y]) => `${x},${y}`).sort();
  assert.deepEqual(combos, ['-1,-1', '-1,1', '1,-1', '1,1']);
});

test('the corner radius is 2px on the toolbar icon', () => {
  assert.equal(Math.round(TOOLBAR_ICON_SIZE * CORNER_RATIO), 2);
  // Stated as a fraction of 32 so the ratio and the pixel value cannot drift.
  assert.equal(CORNER_RATIO, 2 / 32);
});

test('the four corners are cut back and the edge midpoints are not', () => {
  const size = TOOLBAR_ICON_SIZE;
  const icon = renderShape({ size, fill: '#19DF96' });
  const last = size - 1 - EDGE_INSET;

  for (const [x, y] of ROUNDED_CORNERS.map(([sx, sy]) => [sx < 0 ? EDGE_INSET : last, sy < 0 ? EDGE_INSET : last])) {
    assert.ok(alphaAt(icon, x, y) < 255, `corner ${x},${y} is not rounded back`);
  }

  const mid = Math.floor(size / 2);
  for (const [x, y] of [
    [mid, EDGE_INSET],
    [last, mid],
    [mid, last],
    [EDGE_INSET, mid],
  ]) {
    assert.equal(alphaAt(icon, x, y), 255, `edge at ${x},${y} should be solid to the rim`);
  }
});

test('the corner is cut back, but only by 2px', () => {
  // The radius is small enough that the very corner pixel is still mostly
  // covered, so this is checked as a coverage fraction against an independently
  // written reference rather than as "is it empty".
  const size = TOOLBAR_ICON_SIZE;
  const icon = renderShape({ size, fill: '#19DF96' });
  const last = size - 1 - EDGE_INSET;

  for (const [x, y] of [
    [EDGE_INSET, EDGE_INSET],
    [last, EDGE_INSET],
    [EDGE_INSET, last],
    [last, last],
  ]) {
    assertClose(alphaAt(icon, x, y), referenceCoverage(size, EDGE_INSET, 2)(x, y) * 255, `corner ${x},${y}`);
  }

  // And the radius is genuinely applied: at 0 the corner is a hard right angle.
  const square = renderShape({ size, fill: '#19DF96', radius: 0 });
  assert.equal(alphaAt(square, EDGE_INSET, EDGE_INSET), 255, 'radius 0 is not a hard corner');
  assert.ok(
    alphaAt(icon, EDGE_INSET, EDGE_INSET) < alphaAt(square, EDGE_INSET, EDGE_INSET),
    'the 2px radius did not reduce the corner',
  );
});

test('a larger radius cuts the corner further, and a smaller one cuts less', () => {
  // Guards against the radius being ignored, or applied to the wrong corners.
  // The comparison stops before the corner is cut away entirely, where there is
  // no longer any gradient left to compare.
  const size = TOOLBAR_ICON_SIZE;
  const alphaFor = (radius) =>
    alphaAt(renderShape({ size, fill: '#19DF96', radius }), EDGE_INSET, EDGE_INSET);

  assert.ok(alphaFor(0) > alphaFor(1), 'radius 0 should cover more of the corner than 1px');
  assert.ok(alphaFor(1) > alphaFor(2), 'a 1px radius should cover more of the corner than 2px');
  assert.ok(alphaFor(2) > alphaFor(3), 'a 2px radius should cover more of the corner than 3px');

  // A 3px radius already cuts the corner away entirely, and it stays away.
  assert.equal(alphaFor(3), 0, 'a 3px radius should clear the corner entirely');
  for (const radius of [4, 6, 12]) {
    assert.equal(alphaFor(radius), 0, `a ${radius}px radius should clear the corner entirely`);
  }
});

test('every pixel matches an independently written coverage reference', () => {
  // The renderer decides alpha by sampling a 4x4 grid per pixel. This reference
  // samples the same geometry far more densely and through a separately written
  // predicate, so agreement to within one sample step means the geometry and the
  // anti-aliasing are both right — including which corners are cut.
  for (const size of ICON_SIZES) {
    const icon = renderShape({ size, fill: '#19DF96' });
    const reference = referenceCoverage(size, EDGE_INSET, Math.round(size * CORNER_RATIO));
    const tolerance = 255 / 16 + 1;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const expected = reference(x, y) * 255;
        if (Math.abs(alphaAt(icon, x, y) - expected) > tolerance) {
          assert.fail(`${size}px pixel ${x},${y}: alpha ${alphaAt(icon, x, y)}, reference ${expected.toFixed(1)}`);
        }
      }
    }
  }
});

test('both straight edges and all four arcs are anti-aliased', () => {
  for (const size of ICON_SIZES) {
    const alphas = alphasIn(renderShape({ size, fill: '#19DF96' }));
    assert.ok(alphas.length > 2, `${size}px has only ${alphas.length} alpha values, no gradient`);
    assert.equal(alphas[0], 0, `${size}px has no fully transparent pixel`);
    assert.equal(alphas.at(-1), 255, `${size}px has no fully opaque pixel`);
  }
});

test('the outermost ring is fully transparent, keeping edges off the clip', () => {
  const size = TOOLBAR_ICON_SIZE;
  const icon = renderShape({ size, fill: '#19DF96' });

  for (let i = 0; i < size; i += 1) {
    for (const [x, y] of [[i, 0], [i, size - 1], [0, i], [size - 1, i]]) {
      assert.equal(alphaAt(icon, x, y), 0, `border pixel ${x},${y} is not transparent`);
    }
  }
});

// --- centring -------------------------------------------------------------

test('the shape sits exactly in the middle of the canvas', () => {
  // Centring is not implied by the coverage figure: a shape shifted down by one
  // pixel covers precisely as much canvas as one sitting still, so a coverage
  // assertion cannot tell the difference. This measures the centroid instead,
  // and checks the bounding box is symmetric about the centre on both axes.
  for (const size of [16, 32, 48, 128, 17, 33]) {
    const icon = renderShape({ size, fill: '#19DF96' });
    let opaque = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (icon.data[(y * size + x) * 4 + 3] === 0) continue;
        opaque++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const mid = (size - 1) / 2;
    assert.equal(maxX - minX, maxY - minY, `${size}: the shape is not square`);
    assert.equal(
      (minX + maxX) / 2,
      mid,
      `${size}: the shape is ${(mid - (minX + maxX) / 2).toFixed(2)}px off centre horizontally`,
    );
    assert.equal(
      (minY + maxY) / 2,
      mid,
      `${size}: the shape is ${(mid - (minY + maxY) / 2).toFixed(2)}px off centre vertically`,
    );
    assert.ok(
      Math.abs(sumX / opaque - mid) < 0.01 && Math.abs(sumY / opaque - mid) < 0.01,
      `${size}: the centroid is not at the centre of the canvas`,
    );
  }
});

test('the shape is centred at the size Chrome actually receives', () => {
  // Stated separately from the sweep above so a failure names the size that
  // ships, rather than one of the hypothetical sizes.
  const size = TOOLBAR_ICON_SIZE;
  const icon = renderShape({ size, fill: getState(3).iconColor });
  const rowSum = [];
  for (let y = 0; y < size; y++) {
    let row = 0;
    for (let x = 0; x < size; x++) if (icon.data[(y * size + x) * 4 + 3] > 0) row++;
    rowSum.push(row);
  }

  // Every row in the middle carries the same width, and the first and last rows
  // are mirror images. A one-pixel nudge breaks the mirror and shows up here as
  // an asymmetry the coverage figure would forgive.
  const mirror = (a) => a.join(',') === [...a].reverse().join(',');
  assert.ok(mirror(rowSum), `the shape's rows are not mirrored about its centre at ${size}px`);
  assert.equal(
    rowSum[0],
    rowSum[size - 1],
    `the shape is not vertically symmetric at ${size}px`,
  );
});

test('the shape uses as much of the canvas as the inset allows', () => {
  const size = TOOLBAR_ICON_SIZE;
  const icon = renderShape({ size, fill: '#19DF96' });
  const covered = [...Array(size * size)].filter((_, i) => icon.data[i * 4 + 3] > 0).length;

  // A full-bleed square would be 100%. One pixel of margin on each side costs
  // (32^2 - 30^2) / 32^2 = 12.3%, and the 2px corners give back a little.
  const fullBleed = size * size;
  const withInset = (size - 2 * EDGE_INSET) ** 2;
  const ratio = covered / fullBleed;

  assert.ok(ratio > withInset / fullBleed - 0.02, `only ${(ratio * 100).toFixed(1)}% of the canvas is used`);
  assert.ok(ratio < 0.95, `${(ratio * 100).toFixed(1)}% of the canvas is used, expected the inset to show`);
});

// --- purity ---------------------------------------------------------------

test('the icon carries exactly one colour, whatever the count', () => {
  // The number moved to the badge, so nothing may be drawn in a second colour
  // any more. This is the invariant that would break if digits came back.
  for (const state of STATES) {
    for (const tabCount of [0, 1, 9, 42, 9999]) {
      const icon = renderShape({ size: TOOLBAR_ICON_SIZE, fill: state.color });
      const colours = coloursIn(icon);
      const [r, g, b] = hexToRgb(state.color);

      assert.deepEqual(
        colours,
        [`${r},${g},${b}`],
        `${state.id} at ${tabCount} tabs drew ${colours.length} colours`,
      );
    }
  }
});

test('the silhouette is identical in every state', () => {
  // Colour is the only thing a state is allowed to change, so the alpha channel
  // must be byte-identical across all five.
  const reference = renderShape({ size: TOOLBAR_ICON_SIZE, fill: '#000000' });
  const alphas = [...reference.data].filter((_, i) => i % 4 === 3);

  for (const state of STATES) {
    const icon = renderShape({ size: TOOLBAR_ICON_SIZE, fill: state.color });
    const theirs = [...icon.data].filter((_, i) => i % 4 === 3);
    assert.deepEqual(theirs, alphas, `${state.id} has a different silhouette`);
  }
});

test('alpha is a pure function of size alone', () => {
  for (const size of ICON_SIZES) {
    const a = renderShape({ size, fill: '#123456' });
    const b = renderShape({ size, fill: '#FEDCBA' });
    const alphaA = [...a.data].filter((_, i) => i % 4 === 3);
    const alphaB = [...b.data].filter((_, i) => i % 4 === 3);
    assert.deepEqual(alphaA, alphaB, `${size}px alpha depends on colour`);
  }
});

// --- legibility -----------------------------------------------------------

test('the shape is legible in every state, on either toolbar theme', () => {
  // The shape is the only thing separating Tablox from its neighbours, and the
  // toolbar background is not ours to choose. The state table's bright hues are
  // for the badge; the shape is filled with `iconColor` so it survives both.
  for (const state of STATES) {
    for (const [label, background] of [['light', '#FFFFFF'], ['dark', '#202124']]) {
      const ratio = contrastRatio(state.iconColor, background);
      assert.ok(
        ratio >= 3,
        `${state.id} on a ${label} toolbar: ${ratio.toFixed(2)}:1, need 3:1 for a non-text graphic`,
      );
    }
  }
});

test('the shape still reads as a square at 16px', () => {
  const icon = renderShape({ size: 16, fill: STATES[0].iconColor });
  const box = inkBox(icon);

  // A circle inscribed in the same box would be about 10px across; a square
  // fills its box, which is the silhouette that has to survive at 16px.
  assert.equal(box.width, 14);
  assert.equal(box.height, 14);
  assert.ok(
    contrastRatio(STATES[0].iconColor, '#FFFFFF') >= 3,
    'the 16px shape is too faint to read',
  );
});

test('a shape is painted, never a stroke — the interior is solid to the edges', () => {
  // At 16px the shape is 14x14, and a rounded-corner square has to be filled
  // edge to edge for that to read as a square rather than an outline.
  const icon = renderShape({ size: 16, fill: '#000000' });
  const mid = 7;
  for (let i = 2; i <= 12; i += 1) {
    for (const [x, y] of [[i, mid], [mid, i]]) {
      assert.equal(alphaAt(icon, x, y), 255, `interior ${x},${y} is not solid`);
    }
  }
});

// --- static manifest icons ------------------------------------------------

test('all four static icons exist and are valid PNGs of the right size', () => {
  for (const size of ICON_SIZES) {
    const bytes = readFileSync(join(ICON_DIR, `icon-${size}.png`));
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `icon-${size}.png is not a PNG`,
    );
    assert.equal(bytes.readUInt32BE(16), size, `icon-${size}.png is not ${size} wide`);
    assert.equal(bytes.readUInt32BE(20), size, `icon-${size}.png is not ${size} tall`);
  }
});

test('the static icons are the Focused shape, so they cannot drift from the worker', () => {
  const focused = STATES[0];
  for (const size of ICON_SIZES) {
    const expected = renderShape({ size, fill: focused.color });
    assert.deepEqual(
      [...pngAlphas(join(ICON_DIR, `icon-${size}.png`))],
      [...expected.data].filter((_, i) => i % 4 === 3),
      `icon-${size}.png does not match the rendered Focused shape`,
    );
  }
});

test('the static icons carry the Focused icon colour', () => {
  // iconColor, not the bright badge hue: the static icons are the toolbar shape,
  // and the shape is filled with the colour that survives a light toolbar.
  const expected = hexToRgb(STATES[0].iconColor).join(',');
  assert.equal(getState(1).iconColor, STATES[0].iconColor, 'a fresh install starts in Focused');

  for (const size of ICON_SIZES) {
    const pixels = pngPixels(join(ICON_DIR, `icon-${size}.png`));
    const seen = new Set();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue;
      seen.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }
    assert.deepEqual([...seen], [expected], `icon-${size}.png is not the Focused icon colour`);
  }
});

// --- PNG decoding (so the static icons are checked, not just their headers) -

/** Decode a filter-type-0 RGBA PNG to raw pixels. */
function pngPixels(path) {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);

  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, `row ${y} uses a PNG filter; the generator writes none`);
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return out;
}

/** Just the alpha bytes of a decoded PNG. */
function pngAlphas(path) {
  const pixels = pngPixels(path);
  return [...pixels].filter((_, i) => i % 4 === 3);
}

// --- independent reference ------------------------------------------------

/**
 * Fraction of the pixel at `[x, x+1] x [y, y+1]` covered by the shape.
 *
 * Deliberately written as a separate dense sampler rather than sharing the
 * renderer's code: it can then disagree with the renderer, which is the entire
 * point of comparing the two. Validated by `referenceCoverage is sane` below.
 *
 * @param {number} size
 * @param {number} inset
 * @param {number} radius
 * @returns {(x: number, y: number) => number}
 */
function referenceCoverage(size, inset, radius) {
  const lo = inset;
  const hi = size - inset;
  const arcs = [
    [lo + radius, lo + radius],
    [hi - radius, lo + radius],
    [lo + radius, hi - radius],
    [hi - radius, hi - radius],
  ];

  return (x, y, N = 48) => {
    let hit = 0;
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) {
        const px = x + (i + 0.5) / N;
        const py = y + (j + 0.5) / N;
        if (px < lo || px > hi || py < lo || py > hi) continue;

        let inside = true;
        for (const [ax, ay] of arcs) {
          const inCornerX = ax === lo + radius ? px < ax : px > ax;
          const inCornerY = ay === lo + radius ? py < ay : py > ay;
          if (inCornerX && inCornerY && Math.hypot(px - ax, py - ay) > radius) {
            inside = false;
            break;
          }
        }
        if (inside) hit += 1;
      }
    }
    return hit / (N * N);
  };
}

/** Assert two alphas agree to within the renderer's own sampling step. */
function assertClose(actual, expected, label) {
  const tolerance = 255 / 16 + 1;
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: alpha ${actual}, reference ${expected.toFixed(1)} (tolerance ${tolerance.toFixed(1)})`,
  );
}

test('referenceCoverage is sane — a 0px radius is a hard square', () => {
  // If the reference itself were wrong, every comparison above would be
  // meaningless, so it is pinned against the one case with an obvious answer.
  const reference = referenceCoverage(32, 1, 0);
  for (const [x, y] of [[1, 1], [3, 3], [16, 16], [30, 30]]) {
    assert.equal(reference(x, y), 1, `radius 0 should fully cover ${x},${y}`);
  }
  assert.equal(reference(0, 0), 0, 'radius 0 should still leave the margin empty');
  assert.equal(Math.round(referenceCoverage(32, 1, 8)(1, 1) * 255), 0, 'an 8px radius clears the corner');
});
