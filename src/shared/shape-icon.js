/**
 * Toolbar shape renderer.
 *
 * Produces the RGBA pixels of a filled square with two rounded corners. Pure
 * JavaScript with no canvas and no font loading, so the service worker, the
 * icon generator, and the tests all produce identical bytes.
 *
 * The tab count is deliberately NOT drawn here. Chrome owns the badge, draws it
 * in its own typeface, and places it in the corner — so the icon only has to
 * carry the state colour and the silhouette. Putting digits in the icon as well
 * would double the number and fight the badge for the same corner.
 *
 * At runtime the worker renders one size and hands it to Chrome, because Chrome
 * accepts a single `imageData` and resamples it — see `TOOLBAR_ICON_SIZE`.
 * `renderShape` is nonetheless correct at any size, and the static manifest
 * icons are generated from it.
 */

import { hexToRgb } from './state.js';

/** Sizes Chrome can be given for a static manifest icon. */
export const ICON_SIZES = [16, 32, 48, 128];

/**
 * The single size handed to `chrome.action.setIcon` at runtime.
 *
 * Chrome accepts exactly one `imageData` — passing an array is rejected
 * outright ("Invalid type: expected ImageDataType|object, found array"), so
 * there is no way to supply a native-resolution image per size and let Chrome
 * pick. Chrome resamples this one image for every surface instead.
 *
 * 32 is the best single compromise: it is the native action-icon size on
 * high-DPI displays, and a clean 2x reduction on standard ones. The only
 * surface that looks soft is the 128px thumbnail on the extensions page, which
 * is rarely looked at, and the toolbar — the whole point of the product — is
 * always sharp.
 */
export const TOOLBAR_ICON_SIZE = 32;

/**
 * Transparent margin on each edge, in pixels.
 *
 * The brief is maximum area, and the shape does use the whole canvas minus this
 * margin. The margin is kept at one pixel for a specific reason: at 32px a
 * shape that bleeds to the very edge has its anti-aliased corner pixels clipped
 * by Chrome's own resampling, which shows up as a faint dark fringe on light
 * toolbars. One pixel of transparency moves the edge off the clip boundary while
 * still covering 90% of the canvas, so nothing visible is lost.
 */
export const EDGE_INSET = 1;

/**
 * Corner radius as a fraction of the shape's side.
 *
 * 2px on the 32px toolbar icon, which is 1/16. Held as a ratio rather than a
 * fixed pixel count so the static 16/48/128px manifest icons keep the same
 * visual weight instead of looking razor-sharp at 16px and bloated at 128px.
 *
 * The radius is deliberately small. This is a square, not a squircle: the
 * corners are softened enough to avoid a harsh aliased point at 32px and no
 * more, so the silhouette still reads as a square at a glance.
 */
export const CORNER_RATIO = 0.0625;

/** Subsamples per axis when anti-aliasing the shape's edges. */
const EDGE_SAMPLES = 4;

/**
 * The corners that are rounded, as `[x, y]` unit offsets from the top-left of
 * the box. All four are listed, so the shape is a square with softened corners.
 *
 * Exported so tests and the real-Chrome harness assert the silhouette actually
 * rendered, instead of trusting the constant.
 */
export const ROUNDED_CORNERS = Object.freeze([
  Object.freeze([-1, -1]),
  Object.freeze([1, -1]),
  Object.freeze([-1, 1]),
  Object.freeze([1, 1]),
]);

/**
 * Render one icon.
 *
 * @param {{ size: number, fill: string, inset?: number, radius?: number,
 *   corners?: ReadonlyArray<readonly [number, number]> }} options
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function renderShape({
  size,
  fill,
  inset = EDGE_INSET,
  radius = Math.round(size * CORNER_RATIO),
  corners = ROUNDED_CORNERS,
}) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  drawShape(pixels, size, fill, inset, radius, corners);
  return { data: pixels, width: size, height: size };
}

/**
 * Anti-aliased filled square with two rounded corners, on a transparent field.
 *
 * Coverage is decided per pixel by sampling a 4x4 grid, so both the straight
 * edges and the two arcs are anti-aliased by the same rule and the shape has no
 * jagged steps at 32px.
 *
 * @param {Uint8ClampedArray} pixels mutated in place
 * @param {number} size
 * @param {string} color
 * @param {number} inset
 * @param {number} radius
 * @param {ReadonlyArray<readonly [number, number]>} corners
 */
function drawShape(pixels, size, color, inset, radius, corners) {
  const [r, g, b] = hexToRgb(color);
  const x0 = inset;
  const y0 = inset;
  const x1 = size - inset;
  const y1 = size - inset;
  const step = 1 / EDGE_SAMPLES;
  const offset = step / 2;

  // A corner is described by the direction its arc centre sits in, relative to
  // the corner point itself. Precomputed so the inner loop stays arithmetic.
  const arcs = corners.map(([sx, sy]) => ({
    cx: sx < 0 ? x0 + radius : x1 - radius,
    cy: sy < 0 ? y0 + radius : y1 - radius,
    left: sx < 0,
    top: sy < 0,
    radiusSq: radius * radius,
  }));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < EDGE_SAMPLES; sy += 1) {
        for (let sx = 0; sx < EDGE_SAMPLES; sx += 1) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          if (contains(px, py, x0, y0, x1, y1, arcs)) hits += 1;
        }
      }

      const alpha = Math.round((hits / (EDGE_SAMPLES * EDGE_SAMPLES)) * 255);
      const i = (y * size + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = alpha;
    }
  }
}

/**
 * Is the point inside the box, with each rounded corner cut back by its arc?
 *
 * A corner only cuts within its own quadrant — the region the arc centre defines
 * — so an arc can never reach across the shape and bite into the opposite edge.
 * A corner with no arc is absent from `arcs`, which is what keeps the two square
 * corners perfectly square.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {ReadonlyArray<{cx: number, cy: number, left: boolean, top: boolean, radiusSq: number}>} arcs
 * @returns {boolean}
 */
function contains(px, py, x0, y0, x1, y1, arcs) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;

  for (const arc of arcs) {
    const beyondX = arc.left ? px < arc.cx : px > arc.cx;
    const beyondY = arc.top ? py < arc.cy : py > arc.cy;
    if (!beyondX || !beyondY) continue;

    const dx = px - arc.cx;
    const dy = py - arc.cy;
    if (dx * dx + dy * dy > arc.radiusSq) return false;
  }

  return true;
}

