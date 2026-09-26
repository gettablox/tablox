/**
 * End-to-end verification of Tablox in real Chrome.
 *
 * The unit suite proves the logic against a fake browser. This proves the
 * extension actually loads, that its MV3 service worker starts, and that the
 * icon and title Chrome really holds match the state table at every boundary.
 *
 * There is no `chrome.action.getIcon()`, so the icon is verified by intercepting
 * `setIcon` inside the live worker: the interception only replaces the sink, so
 * the production path — tab event, count, state, render, hand to Chrome — is
 * what actually runs. The pixels come back over CDP and are checked here against
 * the real state table.
 *
 * It reads Chrome's own `getBadgeText`, `getBadgeBackgroundColor` and
 * `getBadgeTextColor` at every count, which is the only way to prove in a real
 * browser that the badge shows the exact number in the right colours. That last
 * getter is also the proof that `setBadgeTextColor` exists in this Chrome: the
 * worker calls it unconditionally, so if the API were missing the worker would
 * have thrown and nothing would have been painted at all.
 *
 * Chrome 137 removed the --load-extension switch, so the extension is loaded
 * through the DevTools `Extensions` domain over a debugging pipe. A temporary
 * browser profile is created and destroyed; your real Chrome is untouched.
 *
 * Usage:  npm run verify:chrome
 *
 * Note: this opens a real Chrome window briefly. It is deliberately NOT part of
 * `npm test`, which must stay fast and headless.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getState, contrastRatio, TOAST_MIN_INTERVAL_MS } from '../src/shared/state.js';
import { TOOLBAR_ICON_SIZE } from '../src/shared/shape-icon.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'src');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Every threshold boundary, a case beyond the last one, and a 3-digit count. */
const TAB_COUNTS = [1, 3, 4, 6, 7, 9, 10, 12, 13, 100];

// --- minimal CDP client over --remote-debugging-pipe ----------------------

class Cdp {
  constructor(stdio) {
    this.input = stdio.input;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';

    stdio.output.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.input.write(`${JSON.stringify(payload)}\0`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20000);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} hex @returns {[number, number, number]} */
function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Compare a colour Chrome handed back with one of ours.
 *
 * `getBadgeBackgroundColor` is specified as returning a list of colours, but
 * over the debugging protocol Chrome serialises a `Color` as a channel array,
 * so what actually arrives is a flat `[r, g, b, a]`. This accepts that, a list
 * of such arrays, a hex string, and `rgb(...)` — comparing channel values
 * throughout, because Chrome lowercases hex and reorders text freely.
 */
/**
 * Composite a translucent colour over an opaque one.
 *
 * @param {[number, number, number]} fg  the toast's own colour
 * @param {number} alpha                 how opaque it is
 * @param {[number, number, number]} bg  what is behind it
 * @returns {string} a `#RRGGBB` string
 */
function composite(fg, alpha, bg) {
  const channel = (i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha));
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`;
}

function sameColor(actual, expectedHex) {
  const want = hexToRgb(expectedHex);
  const matches = (got) => got.length >= 3 && want.every((channel, i) => got[i] === channel);

  if (typeof actual === 'string') {
    const text = actual.trim();
    if (text.startsWith('#')) return matches(hexToRgb(text));
    const rgb = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return rgb ? matches(rgb.slice(1, 4).map(Number)) : false;
  }
  if (Array.isArray(actual)) {
    if (matches(actual)) return true;
    return actual.some((entry) => Array.isArray(entry) && matches(entry));
  }
  return false;
}

/**
 * Assert the badge is legible, using the colours Chrome itself reports.
 *
 * The design only ever picks between black and white, so anything else is a bug.
 * Of the two, the better must have been chosen — a badge can clear 4.5:1 with
 * white text on a dark background while still being the worse of the pair.
 *
 * @param {unknown} background as returned by getBadgeBackgroundColor
 * @param {unknown} textColor as returned by getBadgeTextColor
 * @returns {string[]} problems found; empty means the badge is legible
 */
function inspectBadgeLegibility(background, textColor) {
  const problems = [];

  // Chrome reports an unset colour as [r, g, b, 0] — the alpha channel is the
  // only thing distinguishing "never set" from "set to black". Reading just the
  // RGB would make a missing setBadgeTextColor look like a deliberate black,
  // which is exactly the case this check exists to catch.
  const parse = (value) => {
    if (Array.isArray(value) && value.length >= 4) {
      return {
        hex: `#${value.slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase(),
        set: value[3] !== 0,
      };
    }
    if (typeof value === 'string' && value.trim().startsWith('#')) {
      return { hex: value.trim().toUpperCase(), set: true };
    }
    return null;
  };

  const bg = parse(background);
  const fg = parse(textColor);
  if (!bg) return [`badge background ${JSON.stringify(background)} could not be read`];
  if (!fg) return [`badge text colour ${JSON.stringify(textColor)} could not be read`];

  if (!fg.set) return ['badge text colour was never set; Chrome would draw its own default'];
  if (!bg.set) return ['badge background was never set'];

  if (fg.hex !== '#000000' && fg.hex !== '#FFFFFF') {
    problems.push(`badge text colour ${fg.hex} is neither black nor white`);
  }
  const ratio = contrastRatio(bg.hex, fg.hex);
  if (ratio < 4.5) problems.push(`badge text ${fg.hex} on ${bg.hex} is only ${ratio.toFixed(2)}:1`);
  if (contrastRatio(bg.hex, '#000000') >= contrastRatio(bg.hex, '#FFFFFF')) {
    if (fg.hex !== '#000000') problems.push(`${fg.hex} on ${bg.hex}, but black is the better choice`);
  } else if (fg.hex !== '#FFFFFF') {
    problems.push(`${fg.hex} on ${bg.hex}, but white is the better choice`);
  }

  return problems;
}

/**
 * Inspect a painted icon, independently of the renderer that produced it.
 *
 * The geometry is checked against literals restated here rather than against the
 * renderer's own constants: a check that imports `CORNER_RATIO` and compares it
 * to `CORNER_RATIO` proves nothing. What is asserted is the shape a 32px square
 * with a 2px corner radius and a 1px margin must have.
 *
 * @param {{width: number, height: number, data: number[]}} icon
 * @param {ReturnType<typeof getState>} state
 * @returns {string[]} problems found; empty means the icon is correct
 */
function inspectIcon(icon, state) {
  const problems = [];
  const { width, height, data } = icon;

  if (width !== height) problems.push(`icon ${width}x${height} is not square`);

  // The 1px margin is spelled out here rather than imported from
  // EDGE_INSET, on the same principle as the badge checks: a harness that reads
  // the expected value out of the module under test cannot notice that value
  // being wrong. `npm test` covers EDGE_INSET; this asserts the spec.
  const fill = hexToRgb(state.iconColor);
  const inset = 1;
  const last = width - 1 - inset;

  let fillPixels = 0;
  let offColour = 0;
  let edgePixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a === 0) continue;

      if (r === fill[0] && g === fill[1] && b === fill[2]) fillPixels += 1;
      else offColour += 1;

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgePixels += 1;
    }
  }

  // The shape is the whole icon now, so the fill should cover nearly the entire
  // 30x30 box and nothing else should be drawn on top of it.
  if (fillPixels < 800) problems.push(`only ${fillPixels} pixels of ${state.iconColor}`);
  if (offColour > 0) problems.push(`${offColour} pixels are not the state colour`);
  if (edgePixels > 0) problems.push(`${edgePixels} edge pixels are opaque; the margin is gone`);

  // The four corners must be cut back. A 2px radius still covers most of the
  // corner pixel, so this is a "less than solid" check rather than "empty".
  const cornerAlpha = (x, y) => data[(y * width + x) * 4 + 3];
  for (const [x, y] of [[inset, inset], [last, inset], [inset, last], [last, last]]) {
    if (cornerAlpha(x, y) >= 255) problems.push(`corner ${x},${y} is square, not rounded`);
  }

  // The edge midpoints must be solid to the rim, or it is a circle or a lozenge.
  const mid = Math.floor(width / 2);
  for (const [x, y] of [[mid, inset], [last, mid], [mid, last], [inset, mid]]) {
    if (cornerAlpha(x, y) !== 255) problems.push(`edge at ${x},${y} is not solid`);
  }

  return problems;
}

// --- run ------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'tablox-verify-'));
const chrome = spawn(
  CHROME,
  [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] },
);

const cdp = new Cdp({ input: chrome.stdio[3], output: chrome.stdio[4] });
const failures = [];

try {
  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
  console.log(`Loaded Tablox (${extensionId})\n`);

  // The worker starts asynchronously; MV3 workers also stop when idle.
  const isTabloxWorker = (target) =>
    target.type === 'service_worker' && target.url.includes('background/service-worker.js');

  /** The worker's current target, looked up fresh: eviction changes its id. */
  const findWorker = async (attempts = 40) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const found = targetInfos.find(isTabloxWorker);
      if (found) return found;
      await sleep(400);
    }
    return null;
  };

  let worker = await findWorker();
  if (!worker) throw new Error('Tablox service worker never started');
  console.log(`Service worker running: ${worker.url}\n`);

  let sessionId = null;
  const attachWorker = async () => {
    if (sessionId) return;
    // Looked up again rather than reusing the id from last time: the worker is
    // stopped on purpose further down, and Chrome gives a restarted worker a new
    // target, so the old one is a dead reference.
    const target = await findWorker();
    if (!target) throw new Error('Tablox service worker is not running');
    worker = target;
    ({ sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    }));
    await cdp.send('Runtime.enable', {}, sessionId);
  };
  const detachWorker = async () => {
    if (!sessionId) return;
    const attached = sessionId;
    sessionId = null;
    await cdp.send('Target.detachFromTarget', { sessionId: attached }).catch(() => {});
  };
  await attachWorker();

  const evaluate = async (expression) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result.result.value;
  };

  /**
   * Wrap `setIcon` in the live worker so the pixels it produces can be read
   * back, while still handing them to the real API.
   *
   * Calling through matters: an intercepted sink would happily accept an
   * `imageData` array that Chrome itself rejects, and the toolbar would then
   * sit on the plain static default forever. Recording the real promise's
   * outcome is what proves Chrome took the icon.
   */
  const installInterceptor = () =>
    evaluate(`(() => {
      globalThis.__tabloxIcon = null;
      globalThis.__tabloxAccepted = null;
      if (!globalThis.__tabloxPatched) {
        globalThis.__tabloxPatched = true;
        const real = chrome.action.setIcon.bind(chrome.action);
        chrome.action.setIcon = (details) => {
          globalThis.__tabloxIcon = details;
          globalThis.__tabloxAccepted = null;
          try {
            return Promise.resolve(real(details)).then(
              () => { globalThis.__tabloxAccepted = 'accepted'; },
              (error) => { globalThis.__tabloxAccepted = 'rejected: ' + (error && error.message); },
            );
          } catch (error) {
            globalThis.__tabloxAccepted = 'threw: ' + (error && error.message);
            return Promise.resolve();
          }
        };
      }
      return true;
    })()`);

  /** Read back the icon the worker last handed to Chrome. */
  const readIcon = () =>
    evaluate(`(() => {
      const details = globalThis.__tabloxIcon;
      if (!details || !details.imageData) return null;
      const image = details.imageData;
      return {
        count: Array.isArray(image) ? image.length : 1,
        width: Array.isArray(image) ? image[0].width : image.width,
        height: Array.isArray(image) ? image[0].height : image.height,
        data: Array.from(Array.isArray(image) ? image[0].data : image.data),
      };
    })()`);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const openedTabs = [];
  let tabCount = targetInfos.filter((target) => target.type === 'page').length;

  async function setTabCount(target) {
    // The worker only repaints in response to a tab event, so if the count is
    // already on target nothing would fire and the icon would go unread. Open
    // and close a scratch tab to force the round trip.
    if (tabCount === target) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      await cdp.send('Target.closeTarget', { targetId });
      await sleep(200);
      return;
    }

    while (tabCount < target) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      openedTabs.push(targetId);
      tabCount += 1;
    }
    while (tabCount > target && openedTabs.length) {
      await cdp.send('Target.closeTarget', { targetId: openedTabs.pop() });
      tabCount -= 1;
    }
  }


  // --- the in-page toast ------------------------------------------------

  // Content scripts are matched by URL, so `about:blank` cannot host the toast:
  // proving it needs a real http origin, which is where users actually are.
  const server = createServer((req, res) => {
    // `?delay=` stands in for a page that is slow to arrive. It is the difference
    // between a content script that is listening when the message lands and one
    // that is not, which is the whole difference between the toast working on a
    // real page and working only on a local one.
    const delay = Number(new URL(req.url, 'http://x').searchParams.get('delay') ?? 0);
    const send = () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
      <title>Tablox toast check</title>
      <style>
        body { margin: 0; font: 16px system-ui; background: #fff; color: #222; }
        .top { height: 120px; display: flex; align-items: center; justify-content: center; }
        button { font: inherit; padding: 8px 16px; }
      </style></head>
      <body>
        <div class="top"><button id="underneath">underneath</button></div>
        <h1>Toast check</h1>
        <div id="page-ready"></div>
      </body></html>`);
    };
    if (delay > 0) setTimeout(send, delay);
    else send();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const toastTargets = [];

  /**
   * Open a real page in its own window and attach to it.
   *
   * Its own window means it is unambiguously the foreground tab there, which is
   * the only way a toast is ever addressed.
   */
  async function openPage() {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: pageUrl,
      newWindow: true,
    });
    toastTargets.push(targetId);
    await sleep(700); // document_idle, plus the content script attaching
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, pageSession);
    return { targetId, pageSession };
  }

  const inPage = async (pageSession, expression) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      pageSession,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? 'page evaluation failed',
      );
    }
    return result.result.value;
  };

  /**
   * What the page is currently showing, read from the real shadow DOM.
   *
   * Read through the shadow root and through `getComputedStyle` rather than off
   * the source, so this measures what Chrome painted and not what we asked for.
   */
  const READ_TOAST = `(() => {
    const host = document.getElementById('tablox-toast-host');
    if (!host) return null;
    const toast = host.shadowRoot && host.shadowRoot.querySelector('.toast');
    if (!toast) return { incomplete: true };
    const cs = getComputedStyle(toast);
    const hs = getComputedStyle(host);
    const rect = toast.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      text: toast.textContent,
      background: cs.backgroundColor,
      color: cs.color,
      fontSize: parseFloat(cs.fontSize),
      position: hs.position,
      pointerEvents: hs.pointerEvents,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      hitIsToast: !!(hit && hit.closest && hit.closest('#tablox-toast-host')),
      hitId: hit ? hit.id || hit.tagName.toLowerCase() : null,
      animations: toast.getAnimations ? toast.getAnimations().length : 0,
    };
  })()`;

  /**
   * The toast's text on a target, or null if it is not showing.
   *
   * Attaching on every call would be wasteful, but these checks run a handful of
   * times and clarity is worth more here than a session cache.
   */
  async function readShadowText(client, targetId) {
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    try {
      const result = await client.send(
        'Runtime.evaluate',
        {
          expression: `(document.getElementById('tablox-toast-host')?.shadowRoot
            ?.querySelector('.toast')?.textContent) ?? null`,
          returnByValue: true,
        },
        sessionId,
      );
      return result.result.value;
    } finally {
      // Detached, because this is called in a polling loop and an attached
      // session per poll is a slow leak of Chrome-side state.
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  /**
   * What the page thinks it is showing, for when a check fails and the reason is
   * not obvious from the outside.
   *
   * The interesting fields are the ones that distinguish "still animating" from
   * "finished animating and never cleaned up", and "visible" from "present but
   * transparent" — a toast can be in the DOM and on no screen at all.
   *
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async function describeToast(sessionId) {
    return inPage(
      sessionId,
      `(() => {
        const host = document.getElementById('tablox-toast-host');
        const toast = host?.shadowRoot?.querySelector('.toast');
        if (!toast) return { present: false };
        const style = getComputedStyle(toast);
        const running = toast.getAnimations().map((a) => ({
          state: a.playState,
          time: Math.round(a.currentTime ?? -1),
        }));
        return {
          present: true,
          opacity: style.opacity,
          transform: style.transform,
          animations: running,
          hostAttached: host.isConnected,
        };
      })()`,
    );
  }

  /**
   * Evict the extension's service worker, as Chrome does when it goes idle.
   *
   * Two ways, in order of preference. `ServiceWorker.stopAllWorkers` is instant if
   * this build honours it — the only service worker in this browser is Tablox's,
   * so "all" means "the one". If it does not, the honest fallback is Chrome's own
   * thirty-second idle timeout, which takes half a minute but is the thing being
   * tested.
   *
   * Either way the target is watched until it disappears, because a stop that
   * does not stop must not pass for an eviction.
   *
   * @returns {Promise<{stopped: boolean, how: string}>}
   */
  async function evictServiceWorker() {
    // Let go first. A worker with a debugger attached is not eligible to be
    // stopped, so holding a session open is the one thing guaranteed to make
    // this check prove nothing.
    await detachWorker();
    const goneWithin = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        if (!targetInfos.some(isTabloxWorker)) return true;
        await sleep(200);
      }
      return false;
    };

    try {
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      if (await goneWithin(3000)) return { stopped: true, how: 'stopAllWorkers' };
    } catch {
      /* this build does not expose it; fall through to the real thing */
    }

    // Chrome stops an idle worker of its own accord after about thirty seconds.
    // Nothing is asked of the extension in the meantime, which is the point.
    return (await goneWithin(60000))
      ? { stopped: true, how: "Chrome's own idle timeout" }
      : { stopped: false, how: 'no' };
  }

  /**
   * Count, from inside the page, how many times a toast has been raised.
   *
   * Installed before the document exists, so it cannot miss the first one. The
   * worker has two routes to the same toast — a retry chain and the content
   * script's own arrival announcement — and they race. Reading the DOM after the
   * fact cannot tell one toast from two of the same text laid over each other;
   * only a page-side observer can.
   *
   * @param {string} targetId
   * @returns {Promise<void>}
   */
  async function watchForToasts(client, targetId) {
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    try {
      await client.send('Page.enable', {}, sessionId);
      await client.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: `(() => {
            window.__tabloxToasts = [];
            const started = () => {
              new MutationObserver(() => {
                const host = document.getElementById('tablox-toast-host');
                const toast = host?.shadowRoot?.querySelector('.toast');
                if (toast && !window.__tabloxToasts.includes(toast)) {
                  window.__tabloxToasts.push(toast);
                }
              }).observe(document.documentElement, { childList: true, subtree: true });
            };
            if (document.documentElement) started();
            else document.addEventListener('readystatechange', started, { once: true });
          })();`,
        },
        sessionId,
      );
    } finally {
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  /**
   * Wait for a page to finish loading, then read the toast off it.
   *
   * Used for the slow-page case, where the interesting question is not whether a
   * toast arrives but whether it survives arriving before its own receiver.
   */
  async function waitForToastAndLoad(client, targetId, timeoutMs) {
    const { sessionId } = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await client.send('Runtime.enable', {}, sessionId);
    const read = async (expression) => {
      const result = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) return null;
      return result.result.value;
    };

    const deadline = Date.now() + timeoutMs;

    // Wait for the real document, not for `readyState` to say 'complete'.
    //
    // A freshly created target is showing a blank document, and a blank document
    // is 'complete' — so reading readiness that way reports the page ready two
    // and a half seconds before it is, and turns a prompt toast into a
    // suspiciously slow one. An element only the served page has settles it.
    while (Date.now() < deadline) {
      if (await read("!!document.getElementById('page-ready')")) break;
      await sleep(150);
    }
    const loadedAt = await read('performance.now()');

    // Poll rather than guess. The interesting number is not just whether the
    // toast arrives, but how long after the page does — measured on the page's
    // own clock, from the moment it was ready, so that neither the harness's
    // scheduling nor the two-second delay that got us here is counted in.
    while (Date.now() < deadline) {
      const text = await read(
        `(document.getElementById('tablox-toast-host')?.shadowRoot
          ?.querySelector('.toast')?.textContent) ?? null`,
      );
      if (text) {
        const shownAt = await read('performance.now()');
        return { text, waitedMs: Math.round(shownAt - loadedAt) };
      }
      await sleep(80);
    }
    return null;
  }

  /** Poll the page until the toast appears, or give up. */
  async function waitForToast(pageSession, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const seen = await inPage(pageSession, READ_TOAST);
      if (seen && !seen.incomplete) return seen;
      await sleep(80);
    }
    return null;
  }

  const toastFailures = [];
  let toastChecks = 0;
  const checkToast = (label, problems) => {
    toastChecks += 1;
    if (problems.length) toastFailures.push(`${label}: ${problems.join(', ')}`);
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'}  toast  ${label}` +
        (problems.length ? `  <- ${problems.join(', ')}` : ''),
    );
  };

  // The order below is not arbitrary: each step's tab count depends on the one
  // before it, and a toast is only due when the count *crosses* a threshold. A
  // check that opens a page without crossing tests nothing, which is how the
  // slow-page case went missing the first time.

  // --- 1. the page that is still loading when the message arrives ----------

  // Three tabs, all Focused. The next one opened is the fourth, so it is the tab
  // doing the crossing — and it is a page that takes 2.5s to arrive, which means
  // its content script is not listening when the toast is first sent.
  for (let i = 0; i < 2; i += 1) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    toastTargets.push(targetId);
  }
  await sleep(400);

  {
    const { targetId: slowTarget } = await cdp.send('Target.createTarget', {
      url: `${pageUrl}?delay=2500`,
      newWindow: true,
    });
    toastTargets.push(slowTarget);
    // Armed before the navigation, so the observer is in place for the very
    // first toast rather than the second.
    await watchForToasts(cdp, slowTarget);

    const seen = await waitForToastAndLoad(cdp, slowTarget, 12000);
    const slowProblems = [];
    if (!seen) {
      slowProblems.push('no toast on a page that took 2.5s to load');
    } else if (seen.text !== getState(4).toast) {
      slowProblems.push(
        `text ${JSON.stringify(seen.text)} should be ${JSON.stringify(getState(4).toast)}`,
      );
    }
    checkToast(
      `crosses on a page 2.5s from loading${seen ? `, toast +${seen.waitedMs}ms after the page was ready` : ''}`,
      slowProblems,
    );

    // And it still cleans up on the slow page, not just the fast one.
    //
    // This is where the two routes to one toast are easiest to catch: the retry
    // chain and the arrival announcement both fire around the moment the page
    // finishes loading, and a page that only ever hears one of them is the whole
    // point.
    const removalStartedAt = Date.now();
    const { sessionId: removalSession } = await cdp.send('Target.attachToTarget', {
      targetId: slowTarget,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, removalSession);
    const removalDeadline = removalStartedAt + 8000;
    let stillThere = null;
    while (Date.now() < removalDeadline) {
      stillThere = await inPage(removalSession, READ_TOAST);
      if (!stillThere) break;
      await sleep(120);
    }
    const stayedMs = Date.now() - removalStartedAt;
    checkToast('removes itself on the slow page too', [
      ...(stillThere
        ? [
            `still there after ${stayedMs}ms` +
              (stayedMs >= 8000
                ? `, and it is ${JSON.stringify(await describeToast(removalSession))}`
                : ''),
          ]
        : []),
    ]);

    const { sessionId: slowSession } = await cdp.send('Target.attachToTarget', {
      targetId: slowTarget,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, slowSession);
    const raised = await inPage(slowSession, 'window.__tabloxToasts?.length ?? 0');
    checkToast('raised exactly once on the slow page', [
      ...(raised > 1 ? [`the toast was raised ${raised} times`] : []),
    ]);
  }

  // A cooldown from the crossing above is still running, and the checks below
  // need to be able to cross again. Waiting it out explicitly beats discovering
  // the interaction as a mysterious failure later.
  await sleep(TOAST_MIN_INTERVAL_MS + 400);

  // --- 2. silence, and then a crossing on a fast page ----------------------

  // Opening a page at 5 tabs crosses nothing — 4 and 5 are both Growing — so
  // this is the "a toast must not appear without a reason" case.
  const quiet = await openPage();
  await sleep(1400);
  checkToast('silent on load, when nothing was crossed', [
    ...((await readShadowText(cdp, quiet.targetId))
      ? ['a toast appeared without a threshold crossing']
      : []),
  ]);

  // 5 -> 6 is still within Growing. Still nothing.
  //
  // In a window of its own, deliberately. A target created without `newWindow`
  // lands in whichever window Chrome considers focused, which is the quiet
  // page's — making the quiet page a background tab, and so a tab the toast
  // would rightly skip. The check would then pass or fail for the wrong reason.
  const { targetId: scratch2 } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  });
  toastTargets.push(scratch2);
  await sleep(1200);
  checkToast('silent within a state (5 → 6, still Growing)', [
    ...((await readShadowText(cdp, quiet.targetId))
      ? ['a toast appeared without a threshold crossing']
      : []),
  ]);

  // 6 -> 7 crosses into Crowded, and this page is the tab doing it.
  const crossed = await openPage();
  const seen = await waitForToast(crossed.pageSession, 6000);

  const expected = getState(7);
  const toastProblems = [];
  if (!seen) {
    toastProblems.push('no toast after crossing 6 → 7');
  } else {
    if (seen.text !== expected.toast) {
      toastProblems.push(`text ${JSON.stringify(seen.text)} should be ${JSON.stringify(expected.toast)}`);
    }
    // rgba() of the state's own badge colour at the specified transparency.
    const [r, g, b] = hexToRgb(expected.color);
    const wantBackground = `rgba(${r}, ${g}, ${b}, 0.94)`;
    if (seen.background !== wantBackground) {
      toastProblems.push(`background ${seen.background} should be ${wantBackground}`);
    }
    if (seen.color !== 'rgb(0, 0, 0)') toastProblems.push(`text colour ${seen.color}`);

    // Small, and at the top of the viewport.
    if (seen.top > 80) toastProblems.push(`top edge is ${seen.top}px down`);
    if (seen.height > 120) toastProblems.push(`${seen.height}px tall is not small`);
    if (seen.width > 600) toastProblems.push(`${seen.width}px wide is not small`);

    // It must not be in the page's flow, and must not eat a click.
    if (seen.position !== 'fixed') toastProblems.push(`position is ${seen.position}, not fixed`);
    if (seen.pointerEvents !== 'none') toastProblems.push(`pointer-events is ${seen.pointerEvents}`);
    if (seen.hitIsToast) toastProblems.push('the toast swallowed a click aimed through it');

    // The background is translucent over a page whose colour Tablox does not
    // control, so legibility has to hold against the worst page there is.
    const textHex = seen.color === 'rgb(0, 0, 0)' ? '#000000' : '#FFFFFF';
    for (const [name, page] of [['a white page', [255, 255, 255]], ['a black page', [0, 0, 0]]]) {
      const ratio = contrastRatio(composite(hexToRgb(expected.color), 0.94, page), textHex);
      if (ratio < 4.5) {
        toastProblems.push(`text is only ${ratio.toFixed(2)}:1 on ${name}, needs 4.5:1`);
      }
    }
  }
  checkToast(`7 tabs · Crowded · ${JSON.stringify(expected.toast)}`, toastProblems);

  // One foreground tab per window is the rule, and this holds it to that: the
  // quiet page is the only tab in its own window and must have been told too.
  const elsewhere = await waitForToast(quiet.pageSession, 3000);
  checkToast('delivered to the foreground tab of the other window', [
    ...(elsewhere ? [] : ['the other window’s foreground tab got nothing']),
  ]);

  // And it takes itself away again, without being asked.
  //
  // Measured from the moment the toast was seen, not from the crossing. The two
  // are not the same question: arriving is the content script's timing, which
  // this harness allows up to six seconds for, while leaving is the toast's own
  // three-second lifetime. Budgeting both against one eight-second deadline
  // cannot work — the slowest permitted arrival plus the lifetime overruns it —
  // so a slow page would fail a check about tidiness for being slow.
  const seenAt = Date.now();
  const goneDeadline = seenAt + 6000;
  let gone = false;
  while (Date.now() < goneDeadline) {
    if ((await inPage(crossed.pageSession, READ_TOAST)) === null) {
      gone = true;
      break;
    }
    await sleep(100);
  }
  const livedMs = Date.now() - seenAt;
  const removalProblems = [];
  if (!gone) removalProblems.push(`still on screen ${livedMs}ms after it appeared`);
  if (gone && livedMs < 1200) removalProblems.push(`gone after only ${livedMs}ms`);
  if (gone && livedMs > 5000) removalProblems.push(`lingered for ${livedMs}ms`);
  checkToast(`removed itself ${livedMs}ms after it appeared`, removalProblems);

  // --- the case that started all of this: a worker that was evicted ---------

  // MV3 stops an idle service worker after about thirty seconds, so in ordinary
  // use almost every crossing is announced by a worker that has been asleep and
  // remembers nothing. A worker that needed the previous state from memory would
  // read the new one as a baseline and say nothing at all — which is how this
  // presented as "the toast does not work" rather than as a bug report.
  //
  // So stop it on purpose, and check it still speaks.
  await sleep(TOAST_MIN_INTERVAL_MS + 400); // let the last crossing's cooldown lapse

  const eviction = await evictServiceWorker();
  checkToast(`the service worker was evicted, by ${eviction.how}`, [
    ...(eviction.stopped ? [] : ['it would not stop, so nothing was proved']),
  ]);

  if (eviction.stopped) {
    // Seven tabs, so three more crosses into Fragmented at ten.
    const woken = [];
    for (let i = 0; i < 3; i += 1) woken.push(await openPage());

    const seen = await waitForToast(woken[2].pageSession, 6000);
    checkToast('a woken worker still announces the crossing', [
      ...(seen ? [] : ['the toast did not survive the worker being stopped']),
      ...(seen && seen.text !== getState(10).toast
        ? [`text ${JSON.stringify(seen.text)} should be ${JSON.stringify(getState(10).toast)}`]
        : []),
    ]);
  }

  failures.push(...toastFailures);

  // The worker was let go of, to be evicted. It is needed again now.
  await attachWorker();

  // Put the tab count back where the toolbar sweep expects to find it.
  for (const targetId of toastTargets) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  await sleep(600);
  console.log('');
  for (const count of TAB_COUNTS) {
    await installInterceptor();
    await setTabCount(count);
    await sleep(500);

    const actual = await evaluate(`(async () => ({
      tabs: (await chrome.tabs.query({})).length,
      badgeText: await chrome.action.getBadgeText({}),
      badgeColor: await chrome.action.getBadgeBackgroundColor({}),
      badgeTextColor: await chrome.action.getBadgeTextColor({}),
      title: await chrome.action.getTitle({}),
    }))()`);
    const icon = await readIcon();

    const expected = getState(count);
    const problems = [];

    if (actual.tabs !== count) problems.push(`counted ${actual.tabs} tabs`);
    if (actual.badgeText !== String(count)) {
      problems.push(`badge "${actual.badgeText}" should be "${count}"`);
    }
    // The badge carries the state's bright colour; the icon carries the darker
    // one. Both are checked, so a swap between them would be caught.
    if (!sameColor(actual.badgeColor, expected.color)) {
      problems.push(
        `badge background ${JSON.stringify(actual.badgeColor)} is not ${expected.color}`,
      );
    }
    // The badge text colour is checked as a property, not against the value the
    // state table happens to hold. Comparing it to `expected.badgeText` would be
    // circular: a table edited to say white would agree with itself and the
    // badge would ship unreadable. What has to be true in a real browser is that
    // the number is legible on the colour Chrome is actually painting behind it.
    problems.push(...inspectBadgeLegibility(actual.badgeColor, actual.badgeTextColor));
    if (!actual.title.includes(expected.label)) problems.push(`title "${actual.title}"`);

    if (!icon) {
      problems.push('no icon reached setIcon');
    } else {
      if (icon.count !== 1) problems.push(`expected 1 image, got ${icon.count}`);
      if (icon.width !== TOOLBAR_ICON_SIZE || icon.height !== TOOLBAR_ICON_SIZE) {
        problems.push(`icon is ${icon.width}x${icon.height}, expected ${TOOLBAR_ICON_SIZE}`);
      }
      problems.push(...inspectIcon(icon, expected));
    }

    // The real setIcon call has to have resolved, or Chrome rejected the
    // imageData and the toolbar is still showing the static default.
    const accepted = await evaluate('globalThis.__tabloxAccepted');
    if (accepted !== 'accepted') {
      problems.push(`Chrome ${accepted ?? 'never resolved'} the real setIcon call`);
    }

    if (problems.length) failures.push(`${count} tabs: ${problems.join(', ')}`);
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'}  ${String(count).padStart(2)} tabs  ` +
        `${expected.color}  badge "${actual.badgeText}"  ${actual.title}` +
        (problems.length ? `  <- ${problems.join(', ')}` : ''),
    );
  }

  for (const targetId of openedTabs) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  const toolbarFailures = failures.length - toastFailures.length;
  console.log(
    `\n${TAB_COUNTS.length - toolbarFailures}/${TAB_COUNTS.length} toolbar checks passed` +
      `, ${toastChecks - toastFailures.length}/${toastChecks} toast checks passed`,
  );
} catch (error) {
  failures.push(error.message);
  console.error(`\nverification could not run: ${error.message}`);
} finally {
  chrome.kill();
  await sleep(700);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Chrome may still be flushing its profile; a stray temp dir is harmless.
  }
}

process.exit(failures.length === 0 ? 0 : 1);
