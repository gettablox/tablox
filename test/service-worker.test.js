/**
 * Service worker behaviour tests.
 *
 * Covers the scenarios the specification requires: tab creation, tab removal,
 * tabs moving between windows, service-worker restart, and multi-window
 * counting.
 *
 * The toolbar is asserted in two halves, because the design splits it in two: the
 * icon carries the state colour and the shape, and Chrome's badge carries the
 * count. `chrome.toolbar()` reports the `ImageData` the worker actually produced
 * and the badge values it last set, and the helpers below pull the fill colour
 * back out of the pixels.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers/source.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFakeChrome,
  installChrome,
  uninstallChrome,
  importFresh,
  flush,
} from './helpers/fake-chrome.js';
import { getState, hexToRgb, contrastRatio } from '../src/shared/state.js';
import { TOOLBAR_ICON_SIZE, renderShape } from '../src/shared/shape-icon.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = join(ROOT, 'src', 'background', 'service-worker.js');
const POPUP_PATH = join(ROOT, 'src', 'popup', 'popup.js');
const WORKER = `file://${WORKER_PATH}`;

let instance = 0;

/**
 * Boot a fresh service worker against a fake browser, and wait for the
 * initial paint. The fake stays installed as `globalThis.chrome`.
 */
async function boot(options) {
  const chrome = createFakeChrome(options);
  installChrome(chrome);
  const module = await importFresh(WORKER, (instance += 1));
  await flush();
  return { chrome, module };
}

test.after(uninstallChrome);

// --- reading the painted toolbar ------------------------------------------

/**
 * The icon the worker painted, as `{data, width, height}`.
 *
 * @param {object} chrome
 */
function paintedIcon(chrome) {
  const icons = chrome.toolbar().icons;
  assert.ok(icons.length > 0, 'nothing was painted');
  return icons[0];
}

/**
 * How many pixels of a painted icon exactly match a colour, ignoring alpha.
 *
 * @param {{data: Uint8ClampedArray, width: number}} icon
 * @param {string} hex
 * @returns {number}
 */
function pixelsOfColour(icon, hex) {
  const [r, g, b] = hexToRgb(hex);
  let found = 0;

  for (let i = 0; i < icon.data.length; i += 4) {
    if (icon.data[i] === r && icon.data[i + 1] === g && icon.data[i + 2] === b && icon.data[i + 3] === 255) {
      found += 1;
    }
  }

  return found;
}

/**
 * The set of distinct colours the icon drew, ignoring alpha.
 *
 * @param {{data: Uint8ClampedArray}} icon
 * @returns {string[]}
 */
function coloursDrawn(icon) {
  const seen = new Set();
  for (let i = 0; i < icon.data.length; i += 4) {
    if (icon.data[i + 3] === 0) continue;
    seen.add(`${icon.data[i]},${icon.data[i + 1]},${icon.data[i + 2]}`);
  }
  return [...seen].sort();
}

/**
 * Assert the whole toolbar is right for this tab count: the badge shows the
 * exact number, the badge and the icon carry the state's colours, and the shape
 * is pixel-identical to the one the renderer produces for that state.
 *
 * @param {object} chrome
 * @param {number} count
 */
function assertToolbar(chrome, count) {
  const state = getState(count);
  const { badge } = chrome.toolbar();

  assert.equal(badge.text, String(count), `${count} tabs: badge text`);
  assert.equal(badge.background, state.color, `${count} tabs: badge background`);
  assert.equal(badge.textColor, state.badgeText, `${count} tabs: badge text colour`);

  const icon = paintedIcon(chrome);
  const expected = renderShape({ size: TOOLBAR_ICON_SIZE, fill: state.iconColor });
  assert.deepEqual(
    [...icon.data],
    [...expected.data],
    `${count} tabs: the painted icon is not the ${state.id} shape`,
  );
}

/** Assert the badge shows this exact count and nothing else. */
function assertBadgeShows(chrome, count) {
  assert.equal(chrome.toolbar().badge.text, String(count), `badge should read ${count}`);
}

// --- scenarios ------------------------------------------------------------

test('initializes the correct state when the service worker starts', async () => {
  const { chrome } = await boot({ windowTabCounts: [3] });

  assert.match(chrome.toolbar().title, /3 tabs · Focused/);
  assertToolbar(chrome, 3);
  assert.ok(
    pixelsOfColour(paintedIcon(chrome), getState(3).iconColor) > 0,
    'the Focused shape was not painted',
  );
});

test('paints exactly one square image, at the single size Chrome accepts', async () => {
  const { chrome } = await boot({ windowTabCounts: [3] });
  const icons = chrome.toolbar().icons;

  // Chrome rejects an array of imageData outright, so there is no per-size
  // array to pass. One image, and Chrome resamples it.
  assert.equal(icons.length, 1, 'exactly one image is handed to setIcon');
  const [icon] = icons;
  assert.equal(icon.width, TOOLBAR_ICON_SIZE, 'served at the toolbar size');
  assert.equal(icon.width, icon.height, 'icons are square');
  assert.equal(icon.data.length, icon.width * icon.height * 4, 'RGBA buffer size');
});

test('the painted icon is a real ImageData, not a plain object', async () => {
  const { chrome } = await boot({ windowTabCounts: [5] });
  const [icon] = chrome.toolbar().icons;

  assert.ok(icon instanceof ImageData, 'setIcon needs a genuine ImageData');
  assert.equal(icon.data.constructor.name, 'Uint8ClampedArray', 'ImageData needs clamped bytes');
  assert.equal(icon.colorSpace, 'srgb');
});

test('the title reads "1 tab", not "1 tabs"', async () => {
  const { chrome } = await boot({ windowTabCounts: [1] });
  assert.match(chrome.toolbar().title, /1 tab · Focused/);
  assert.doesNotMatch(chrome.toolbar().title, /1 tabs/);

  const { chrome: two } = await boot({ windowTabCounts: [2] });
  assert.match(two.toolbar().title, /2 tabs · Focused/);
});

test('counts tabs across multiple windows', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [2, 3, 4] });
  const state = await module.refresh();

  assert.equal(chrome.tabCount(), 9);
  assert.equal(state.tabCount, 9);
  assert.equal(state.id, 'crowded');
  assertToolbar(chrome, 9);
});

test('a window opened later is included in the count', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [2] });
  assert.equal((await module.refresh()).tabCount, 2);

  chrome.addWindow(3);
  const state = await module.refresh();

  assert.equal(state.tabCount, 5);
  assert.equal(state.id, 'growing');
  assertToolbar(chrome, 5);
});

test('tab creation advances the count and the state', async () => {
  const { chrome } = await boot({ windowTabCounts: [3] });
  const before = [...paintedIcon(chrome).data].join(',');

  chrome.openTab();
  await flush();

  assertToolbar(chrome, 4);
  assert.notEqual(
    [...paintedIcon(chrome).data].join(','),
    before,
    'icon did not change when the state changed',
  );
  assert.ok(
    pixelsOfColour(paintedIcon(chrome), getState(4).iconColor) > 0,
    'the Growing shape was not painted',
  );
  assert.equal(
    pixelsOfColour(paintedIcon(chrome), getState(3).iconColor),
    0,
    'the Focused colour is still present',
  );
});

test('tab removal recedes the count and the state', async () => {
  const { chrome } = await boot({ windowTabCounts: [5] });
  const tab = chrome.openTab();
  await flush();
  assertToolbar(chrome, 6);

  chrome.closeTab(tab.id);
  await flush();

  assertToolbar(chrome, 5);
  assert.match(chrome.toolbar().title, /5 tabs · Growing/);
});

test('closing a tab recedes across a state boundary', async () => {
  const { chrome } = await boot({ windowTabCounts: [6] });

  // 6 is the last Growing tab; opening one crosses into Crowded, and
  // closing it must fall back.
  const opened = chrome.openTab();
  await flush();
  assertToolbar(chrome, 7);
  assert.match(chrome.toolbar().title, /7 tabs · Crowded/);

  chrome.closeTab(opened.id);
  await flush();
  assertToolbar(chrome, 6);

  assert.match(chrome.toolbar().title, /6 tabs · Growing/);
});

test('moving a tab between windows leaves the count unchanged', async () => {
  const { chrome } = await boot({ windowTabCounts: [4, 3] });
  const before = [...paintedIcon(chrome).data].join(',');

  const tabId = (await chrome.tabs.query({}))[0].id;
  chrome.moveTab(tabId, 2);
  await flush();

  assert.equal(chrome.tabCount(), 7, 'still seven tabs in total');
  assertToolbar(chrome, 7);
  assert.equal(
    [...paintedIcon(chrome).data].join(','),
    before,
    'the icon changed even though the total did not',
  );
});

test('the icon changes at every state boundary', async () => {
  for (const count of [3, 4, 6, 7, 9, 10, 12, 13]) {
    const { chrome, module } = await boot({ windowTabCounts: [count] });
    const state = await module.refresh();

    assert.equal(state.tabCount, count, `${count} tabs counted`);
    assertToolbar(chrome, count);
    assert.ok(
      pixelsOfColour(paintedIcon(chrome), state.iconColor) > 0,
      `${count} tabs: the shape is not the ${state.id} colour`,
    );
  }
});

test('the badge shows the exact count at every boundary and beyond', async () => {
  // The badge is the only place the number appears, so it has to be right at
  // every count, not just the ones that happen to be a state's first.
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 99, 100, 999]) {
    const { chrome, module } = await boot({ windowTabCounts: [1] });
    for (let i = 1; i < count; i += 1) chrome.openTab();
    await module.refresh();

    assertBadgeShows(chrome, count);
  }

  // Zero has to be reached by closing, and the badge must read "0" rather than
  // go blank — a blank badge and a zero look identical until you count pixels.
  const { chrome, module } = await boot({ windowTabCounts: [1] });
  chrome.closeTab((await chrome.tabs.query({}))[0].id);
  await module.refresh();
  assertBadgeShows(chrome, 0);
});

test('the badge text is the bare count, with nothing that would de-centre it', async () => {
  // Chrome centres the text inside the badge pill, and gives no control over
  // that. What it does centre is whatever string it is handed — so padding,
  // whitespace, a unit suffix, or a separator all end up shifting the digits
  // off the middle of the pill while every other badge assertion still passes,
  // because the fake stores the string verbatim either way. Asserted here so
  // the text stays exactly the digits.
  for (const count of [0, 1, 9, 10, 99, 100, 1000, 12345]) {
    const { chrome, module } = await boot({ windowTabCounts: [1] });
    // Zero cannot be reached by opening, so close the one tab instead.
    if (count === 0) chrome.closeTab((await chrome.tabs.query({}))[0].id);
    else for (let i = 1; i < count; i += 1) chrome.openTab();
    await module.refresh();

    const { text } = chrome.toolbar().badge;
    assert.equal(chrome.toolbar().badge.text, String(count), `${count} tabs: badge should read ${count}`);
    assert.doesNotMatch(text, /\s/, `${count} tabs: badge text has whitespace, which shifts it off centre`);
    assert.doesNotMatch(text, /[^\d]/, `${count} tabs: badge text should be digits only`);
  }
});

test('each state paints a visibly different icon', async () => {
  const painted = [];
  for (const count of [2, 5, 8, 11, 15]) {
    const { chrome } = await boot({ windowTabCounts: [count] });
    painted.push([...paintedIcon(chrome).data].join(','));
  }
  assert.equal(new Set(painted).size, 5, 'two states paint identical icons');
});

test('the icon draws no number — the badge is the only place the count appears', async () => {
  for (const count of [1, 7, 42, 1234]) {
    const { chrome } = await boot({ windowTabCounts: [1] });
    for (let i = 1; i < count; i += 1) chrome.openTab();
    await flush();

    const state = getState(count);
    assert.deepEqual(
      coloursDrawn(paintedIcon(chrome)),
      [hexToRgb(state.iconColor).join(',')],
      `${count} tabs: the icon drew more than its fill colour`,
    );
  }
});

test('the badge and the icon both follow the state colour', async () => {
  for (const count of [2, 5, 8, 11, 14]) {
    const { chrome } = await boot({ windowTabCounts: [1] });
    for (let i = 1; i < count; i += 1) chrome.openTab();
    await flush();

    const state = getState(count);
    const { badge } = chrome.toolbar();
    assert.equal(badge.background, state.color, `${count} tabs: badge background`);
    assert.ok(
      contrastRatio(badge.background, badge.textColor) >= 4.5,
      `${count} tabs: badge text is not legible on the badge`,
    );
  }
});

test('the count shown is the number, never the state name', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [9] });
  const state = await module.refresh();

  assert.equal(state.label, 'Crowded');
  assertBadgeShows(chrome, 9);
  assert.doesNotMatch(chrome.toolbar().title, /icon/i);
});

test('a restarted service worker recomputes state from the live browser', async () => {
  const { chrome } = await boot({ windowTabCounts: [2] });
  assertToolbar(chrome, 2);

  // Tabs change while the worker is terminated; no event is delivered to it.
  for (let i = 0; i < 10; i += 1) chrome.openTab();
  await flush();
  assertToolbar(chrome, 12);

  // Chrome revives the worker: a fresh module repaints from scratch rather
  // than restoring anything from storage.
  const revived = await importFresh(WORKER, (instance += 1));
  await flush();

  assertToolbar(chrome, 12);
  assert.match(chrome.toolbar().title, /12 tabs · Fragmented/);
  assert.equal(typeof revived.refresh, 'function');
});

test('closing an entire window updates the count', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [3, 9] });
  assert.equal((await module.refresh()).tabCount, 12);
  assertToolbar(chrome, 12);

  chrome.closeWindow(2);
  await flush();

  assertToolbar(chrome, 3);
  assert.match(chrome.toolbar().title, /3 tabs · Focused/);
});

test('falls back to the tab list when the windows API is unavailable', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [5, 7], withWindowsApi: false });
  const state = await module.refresh();

  assert.equal(chrome.windows, undefined, 'windows API genuinely absent');
  assert.equal(state.tabCount, 12, 'tabs across both windows still counted');
  assertToolbar(chrome, 12);
});

test('zero tabs clamps to the first state and the badge still reads 0', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [1] });
  chrome.closeTab((await chrome.tabs.query({}))[0].id);
  await flush();

  const state = getState(0);
  assert.equal(state.id, 'focused', 'clamped to the first state');
  assert.ok(
    pixelsOfColour(paintedIcon(chrome), state.iconColor) > 0,
    'zero tabs should still paint the Focused shape',
  );
  assert.equal(chrome.toolbar().badge.text, '0', 'the badge should read 0, not be blank');
  assert.match(chrome.toolbar().title, /0 tabs · Focused/);
});

test('subscribes to exactly the four required tab events plus startup', async () => {
  const { chrome } = await boot({ windowTabCounts: [1] });

  for (const name of ['onCreated', 'onRemoved', 'onAttached', 'onDetached']) {
    assert.equal(chrome.tabs[name].listeners.length, 1, `tabs.${name}`);
  }
  assert.equal(chrome.runtime.onStartup.listeners.length, 1, 'runtime.onStartup');
  assert.equal(chrome.runtime.onInstalled.listeners.length, 1, 'runtime.onInstalled');
});

test('sets the badge text colour, not just the background', async () => {
  // Chrome's default badge text is white, which is unreadable on all five of
  // these colours. The call has to be there, and unconditional.
  const source = readFileSync(WORKER_PATH, 'utf8');
  assert.match(source, /setBadgeTextColor/, 'the worker never sets the badge text colour');
  assert.doesNotMatch(source, /if\s*\([^)]*setBadgeTextColor/, 'the text colour must not be conditional');

  const { chrome } = await boot({ windowTabCounts: [4] });
  assert.equal(chrome.action.calls.setBadgeTextColor.length, 1, 'setBadgeTextColor was not called once');
  assert.equal(chrome.action.calls.setBadgeText.length, 1, 'setBadgeText was not called once');
  assert.equal(chrome.action.calls.setBadgeBackgroundColor.length, 1, 'background was not set once');
});

test('never reads tab URLs, titles, or any page content', async () => {
  const source = readFileSync(WORKER_PATH, 'utf8');

  for (const forbidden of ['.url', '.title', '.favIconUrl', 'favicon', 'document.', 'innerHTML']) {
    assert.ok(!source.includes(forbidden), `worker references ${forbidden}`);
  }
  // Two queries are allowed, and only two: the bare count, and the
  // foreground-tab filter the toast needs. Neither selects or returns anything a
  // page owns — `active: true` is a filter over the same bare tab records, not a
  // request for their contents.
  assert.match(source, /chrome\.tabs\.query\(\{\}\)/);
  for (const [, args] of source.matchAll(/chrome\.tabs\.query\(([^)]*)\)/g)) {
    assert.match(
      args.trim(),
      /^(\{\}|\{\s*active:\s*true\s*\})$/,
      `tabs.query called with ${args.trim()}, which is neither the bare count nor the active-tab filter`,
    );
  }
});

test('reacts to tab events rather than polling for them', async () => {
  const source = readFileSync(WORKER_PATH, 'utf8');

  // Polling is what this guard is really about: a battery cost, and a standing
  // excuse to ask for permissions nothing needs. These would all poll.
  for (const forbidden of ['setInterval', 'alarms', 'requestAnimationFrame']) {
    assert.ok(!source.includes(forbidden), `worker uses ${forbidden}`);
  }

  // Two short timers are allowed, and both are answers to a question that cannot
  // be asked any other way: "when have the tab events stopped?" (the debounce)
  // and "is that tab ready yet?" (the delivery retry). Neither may be allowed to
  // run forever, so each is pinned to the one construct that bounds it.
  assert.match(source, /clearTimeout/, 'the debounce must be cancellable');

  // The debounce's callback must not be able to re-arm it. If `decideToast`
  // could schedule again, the worker would wake itself forever and would have
  // earned the ban it just escaped.
  const decideToast = source.slice(source.indexOf('function decideToast'));
  assert.ok(decideToast.length > 0, 'the debounce callback should exist to inspect');
  const decideBody = decideToast.slice(0, decideToast.indexOf('\n}') + 2);
  assert.ok(
    !/setTimeout\(|setInterval\(|scheduleToastDecision\(/.test(decideBody),
    'the debounce callback re-arms the timer, which is polling',
  );

  // The delivery retry is bounded by a finite, named schedule and nothing else.
  // A `while` or a `for` loop here would be the same poll in different clothes.
  const deliver = source.slice(
    source.indexOf('async function deliverToTab'),
    source.indexOf('\n}', source.indexOf('async function deliverToTab')),
  );
  assert.match(
    deliver,
    /for \(const wait of TOAST_DELIVERY_BACKOFF_MS\)/,
    'delivery must iterate the fixed backoff schedule',
  );
  // Exactly one loop, and it is the one above. A `while`, or a second `for`,
  // would be the same endless retry wearing a different hat.
  //
  // Counted over code, not prose: these words turn up in English sentences in
  // the comments, and a comment that starts failing a structural test gets
  // rewritten until it is vaguer rather than until the test is right.
  const loops = stripComments(deliver).match(/\bwhile\b|\bdo\b|\bfor\b/g) ?? [];
  assert.equal(loops.length, 1, `delivery has ${loops.length} loops, expected 1`);

  // Finally, no timer may be armed anywhere else. A count would break the next
  // legitimate use; a location does not.
  const arming = [...source.matchAll(/setTimeout\(/g)].map((match) => match.index);
  const allowed = [
    source.indexOf('function scheduleToastDecision'),
    source.indexOf('async function deliverToTab'),
  ];
  for (const at of arming) {
    // The function that armed it is the nearest one declared above it.
    const owner = allowed
      .filter((start) => start !== -1 && start < at)
      .sort((a, b) => b - a)[0];
    assert.ok(
      owner !== undefined && at - owner < 1200,
      `a timer is armed at offset ${at}, outside the debounce and the delivery retry`,
    );
  }
});

test('does not use storage, scripting, cookies, or the network', async () => {
  const source = readFileSync(WORKER_PATH, 'utf8');

  for (const forbidden of [
    'chrome.storage',
    'chrome.cookies',
    'chrome.scripting',
    'chrome.history',
    'chrome.bookmarks',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'navigator.sendBeacon',
  ]) {
    assert.ok(!source.includes(forbidden), `worker uses ${forbidden}`);
  }
});

test('the popup never writes to the toolbar', async () => {
  const source = readFileSync(POPUP_PATH, 'utf8');

  for (const forbidden of ['chrome.action', 'setIcon', 'setTitle', 'setBadge']) {
    assert.ok(!source.includes(forbidden), `popup references ${forbidden}`);
  }
});
