/**
 * Tablox state system.
 *
 * This module is the ONLY place in the codebase where tab-count thresholds,
 * state colours, and state metadata are defined. The popup and the background
 * service worker both import from here. To change a threshold or a colour, edit
 * STATES below — nothing else.
 *
 * This module is pure. It performs no I/O and touches no browser API.
 */

/** The two candidate badge text colours. */
const BLACK = '#000000';
const WHITE = '#FFFFFF';

/** Chrome's dark toolbar colour, the worst realistic background for a dark tone. */
const DARK_TOOLBAR = '#202124';

/**
 * Relative luminance aimed at for the icon shape.
 *
 * The toolbar background is the extension's only real constraint, and it is not
 * under our control: the same icon has to work on Chrome's light theme and its
 * dark one. A single colour that clears 3:1 against both is narrow but real —
 * it needs a luminance between 0.146 and 0.300 — and sitting in the middle of
 * that band gives about 4:1 each way, which is the reason this is aimed at
 * rather than merely bounded.
 */
const ICON_TARGET_LUMINANCE = 0.215;

/**
 * The five states, in ascending order of tab count.
 *
 * `minTabs` is inclusive. `maxTabs` is inclusive, or `null` for open-ended.
 * Ranges must stay contiguous and non-overlapping: each `minTabs` equals the
 * previous `maxTabs + 1`. `test/state.test.js` asserts this.
 *
 * Each state carries two colours, and they are deliberately different:
 *
 * - `color` is the bright, saturated hue. It is the badge background, where it
 *   sits behind near-black text on a small pill and reads as a vivid chip.
 * - `iconColor` is the same hue and saturation at a darker lightness. It fills
 *   the toolbar shape. The five specified colours are all bright, and four of
 *   them fall below 3:1 on a white toolbar — the yellow at 1.49:1 is close to
 *   invisible — so the shape cannot use them directly. `iconColor` is derived
 *   from `color` rather than hand-written, so editing a colour cannot silently
 *   break the contrast guarantee; `test/state.test.js` asserts both pairs.
 *
 * `badgeText` is derived the same way, and for the same reason: Chrome's default
 * badge text is white, which is unreadable on all five bright colours.
 *
 * @type {ReadonlyArray<Readonly<{
 *   id: string,
 *   label: string,
 *   color: string,
 *   iconColor: string,
 *   badgeText: string,
 *   range: string,
 *   minTabs: number,
 *   maxTabs: number|null,
 *   explanation: string,
 *   toast: string,
 *   toastClose: string
 * }>>}
 *
 * `toast` and `toastClose` are the one-line quips shown in the in-page toast, and
 * unlike `explanation` they are allowed to be a little wry — the popup is where
 * the product states its position carefully, and the toast is allowed to be
 * brief. It is the only place the extension puts words over someone's work, so it
 * carries the state's colour and nothing else: no controls, no markup from us,
 * and no text the state table does not already define.
 *
 * There are two lines per state because the same threshold is crossed in two
 * directions, and they are different sentences about different events. Someone who
 * has just opened a seventh tab and someone who has just closed three are in the
 * same state and have not done the same thing; "Things are starting to pile up"
 * said to the second of them is simply wrong, not merely less apt. The state
 * knows the range and the colour, and only the worker knows which way the count
 * moved, so the choice between the two is made there.
 *
 * The lowest state is the one place the two lines coincide, and that is a
 * property of its copy rather than a fallback the code applies: at 1–3 tabs there
 * is nothing to make room for and nothing to shrink, so there is only one thing
 * worth saying. A state with a real pile to talk about needs two.
 */
export const STATES = Object.freeze(
  [
    ['focused', 'Focused', '#19DF96', '1–3', 1, 3,
      'Your browser context is light, with little to keep track of.',
      'Clean slate. Enjoy it',
      'Clean slate. Enjoy it'],
    ['growing', 'Growing', '#639CFF', '4–6', 4, 6,
      'More information is building up in your browser context.',
      'A few tabs never hurt',
      'Making some room'],
    ['crowded', 'Crowded', '#FDCF06', '7–9', 7, 9,
      'More information is making it harder to quickly find what you need.',
      'Things are starting to pile up',
      'The pile is shrinking'],
    ['fragmented', 'Fragmented', '#FF6F00', '10–12', 10, 12,
      'Different pages and tasks are competing for your attention.',
      'Tab archaeology begins',
      'The excavation continues'],
    ['overloaded', 'Overloaded', '#FF343A', '13+', 13, null,
      'There is a lot to organize, find, and return to.',
      'The browser has entered its archival era',
      'The archive is shrinking'],
  ].map(([id, label, color, range, minTabs, maxTabs, explanation, toast, toastClose]) =>
    Object.freeze({
      id,
      label,
      color,
      iconColor: darkenToLuminance(color, ICON_TARGET_LUMINANCE),
      badgeText: bestTextOn(color),
      range,
      minTabs,
      maxTabs,
      explanation,
      toast,
      toastClose,
    }),
  ),
);

/** The state used for a tab count below the first defined range (0 tabs). */
const CLAMPED_STATE = STATES[0];

/**
 * Minimum gap between two toasts, in milliseconds.
 *
 * Without this, hovering either side of a threshold fires a toast on every
 * crossing: nudging a tab count from 9 to 10 to 9 would stack three lines in a
 * few seconds, which reads as nagging rather than as a signal.
 */
export const TOAST_MIN_INTERVAL_MS = 4000;

/**
 * How long the tab events must stay quiet before a toast decision is made.
 *
 * Opening five tabs fires five events in a few hundred milliseconds, and a
 * threshold can be crossed more than once inside that burst. Deciding on each
 * event would raise a toast per crossing; deciding on a timer means the decision
 * is made once, against the state the user has actually settled on, so
 * `3 → 4 → 5 → 6 → 7` raises one line — Crowded's, not Growing's.
 *
 * Kept in the same module as the rest of the policy so the timing and the rule
 * that uses it cannot drift apart.
 */
export const TOAST_DEBOUNCE_MS = 400;

/**
 * How long to keep trying to hand a toast to a tab, in milliseconds.
 *
 * The tab that crosses a threshold is almost always the tab the user has just
 * opened, and that tab is still loading — its content script is registered at
 * `document_idle` and has not run yet. A single send lands in the gap, is
 * refused with "Receiving end does not exist", and the toast is simply lost, on
 * exactly the page the user is looking at.
 *
 * So delivery is retried — briefly, and only to cover the ordinary cases: a tab
 * that was already loaded (a crossing caused by *closing* a tab lands on a
 * foreground tab that has been there all along), and a page that is a moment
 * behind.
 *
 * Retry is a guess about when a tab will be ready, and a slow page beats any
 * guess. So the guess is kept short and the real answer comes from the tab
 * itself: a content script announces itself when it loads, and the worker hands
 * over the crossing it missed at once. `TOAST_MISS_WINDOW_MS` is how long that
 * offer stays open.
 *
 * The schedule is also where a tab that never becomes ready — a `chrome://`
 * page, a download, a dead connection — is given up on. Retrying costs nothing
 * for those; they refuse every time. What matters is that the worker stops.
 */
export const TOAST_DELIVERY_BACKOFF_MS = [0, 300, 900];

/**
 * How long a crossing stays available to a tab that was not ready for it.
 *
 * A tab that announces itself within this window of the crossing gets the toast
 * it missed. Past it, the line is stale and a tab opening now is simply opening
 * now.
 *
 * Four seconds was the wrong length, and measurably so. It covers a page that
 * was *already* on its way, but the tab that opens a crossing is the tab the
 * user has just opened, and for a while that tab is not a page at all: it is the
 * New Tab page, which takes no content script and therefore never announces
 * itself. The offer is not waiting on the network. It is waiting on a person to
 * type or paste a URL, pick a bookmark, or read a page before moving on — and
 * that routinely takes longer than four seconds. A short window therefore drops
 * the toast in exactly the ordinary case it exists for.
 *
 * A long window is safe here for two reasons. Only a tab the crossing was aimed
 * at may claim it, so a late arrival is never shown in a tab the user is not
 * looking at. And any newer crossing replaces this one outright, so offers
 * cannot pile up or arrive out of order.
 *
 * Thirty seconds, which is also how long Chrome waits before stopping an idle MV3
 * worker. The offer therefore cannot outlive the worker holding it: whatever the
 * window says, the process says the same.
 */
export const TOAST_MISS_WINDOW_MS = 30000;

/**
 * Decide whether entering `nextId` should raise a toast.
 *
 * Pure, and kept here rather than in the worker so the policy can be tested
 * without a browser or a clock.
 *
 * Three rules, in order:
 *
 * 1. A `previousId` of null means the worker has just woken and is recording a
 *    baseline, not reacting to a change. MV3 workers are evicted when idle, so
 *    the in-memory state is gone every time one restarts; treating that as a
 *    change would raise a toast on every wake, which is the single most
 *    important thing to avoid. The cost is the mirror image: a threshold
 *    crossed while the worker was asleep raises nothing, because by the time it
 *    boots the new count is already the baseline.
 * 2. Staying in the same state raises nothing. Only entering a state counts —
 *    otherwise every tab event would raise a toast for the state you are
 *    already in.
 * 3. A toast raised less than `TOAST_MIN_INTERVAL_MS` ago is suppressed.
 *
 * @param {string|null} previousId the state last seen, or null when unknown
 * @param {string|null} nextId the state now
 * @param {{ lastShownAt?: number|null, now?: number }} [timing]
 * @returns {boolean}
 */
export function shouldShowToast(previousId, nextId, timing = {}) {
  const { lastShownAt = null, now = 0 } = timing;
  if (previousId == null || nextId == null) return false;
  if (previousId === nextId) return false;
  if (lastShownAt != null && now - lastShownAt < TOAST_MIN_INTERVAL_MS) return false;
  return true;
}

/**
 * @param {string} hex `#RRGGBB`
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * @param {[number, number, number]} rgb
 * @returns {string} `#RRGGBB`
 */
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * WCAG relative luminance of a hex colour.
 *
 * @param {string} hex
 * @returns {number}
 */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two hex colours.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Pick black or white — whichever is more legible on `background`.
 *
 * Chrome picks the badge's text colour itself, and its default is white. Every
 * colour in this table is bright enough that white would fail badly on it, so
 * the choice is made here instead of being inherited as a default that happens
 * to be wrong.
 *
 * @param {string} background
 * @returns {string} `#000000` or `#FFFFFF`
 */
export function bestTextOn(background) {
  return contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? BLACK : WHITE;
}

/**
 * Darken `hex` to `target` relative luminance, keeping its hue and saturation.
 *
 * Lightness in HSL moves luminance monotonically, so a bisection lands on the
 * exact value. Working in HSL is what keeps the result recognisably the same
 * colour: the alternative — scaling RGB channels — drifts hue as it darkens, and
 * a darkened orange turns brown.
 *
 * @param {string} hex `#RRGGBB`
 * @param {number} target relative luminance, 0-1
 * @returns {string} `#RRGGBB`
 */
export function darkenToLuminance(hex, target) {
  const [h, s] = rgbToHsl(hexToRgb(hex));
  let lo = 0;
  let hi = 1;

  for (let step = 0; step < 40; step += 1) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(rgbToHex(hslToRgb(h, s, mid))) < target) lo = mid;
    else hi = mid;
  }

  return rgbToHex(hslToRgb(h, s, (lo + hi) / 2));
}

/**
 * @param {[number, number, number]} rgb
 * @returns {[number, number, number]} `[hue 0-360, saturation 0-1, lightness 0-1]`
 */
function rgbToHsl([r, g, b]) {
  const [red, green, blue] = [r, g, b].map((c) => c / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red
      ? 60 * (((green - blue) / delta) % 6)
      : max === green
        ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);

  return [(hue + 360) % 360, saturation, lightness];
}

/**
 * @param {number} h hue, 0-360
 * @param {number} s saturation, 0-1
 * @param {number} l lightness, 0-1
 * @returns {[number, number, number]}
 */
function hslToRgb(h, s, l) {
  const chroma = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    return l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)].map((v) => Math.round(v * 255));
}

/**
 * Resolve a tab count to its state.
 *
 * Pure and total: any input returns a valid state. Counts below the first
 * range clamp to the first state, so 0 tabs reads as the smallest context.
 *
 * @param {number} tabCount
 * @returns {{
 *   id: string,
 *   label: string,
 *   color: string,
 *   iconColor: string,
 *   badgeText: string,
 *   range: string,
 *   minTabs: number,
 *   maxTabs: number|null,
 *   explanation: string,
 *   toast: string,
 *   toastClose: string,
 *   tabCount: number
 * }}
 */
export function getState(tabCount) {
  const count = Number.isFinite(tabCount) ? Math.max(0, Math.floor(tabCount)) : 0;
  const state = findState(count);

  return Object.freeze({
    id: state.id,
    label: state.label,
    color: state.color,
    iconColor: state.iconColor,
    badgeText: state.badgeText,
    range: state.range,
    minTabs: state.minTabs,
    maxTabs: state.maxTabs,
    explanation: state.explanation,
    toast: state.toast,
    toastClose: state.toastClose,
    tabCount: count,
  });
}

/**
 * Look up the state whose range contains `count`.
 *
 * @param {number} count
 * @returns {Readonly<{id: string, label: string, color: string, iconColor: string,
 *   badgeText: string, range: string, minTabs: number, maxTabs: number|null,
 *   explanation: string, toast: string, toastClose: string}>}
 */
function findState(count) {
  for (const state of STATES) {
    if (state.maxTabs === null || count <= state.maxTabs) {
      return state;
    }
  }
  return CLAMPED_STATE;
}
