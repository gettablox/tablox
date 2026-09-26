/**
 * Tablox background service worker.
 *
 * Sole writer of the toolbar: icon, badge, and title. It never inspects page
 * content — the only tab data it touches is the count returned by the query.
 *
 * The number lives in Chrome's own badge, not in the icon. Chrome draws the
 * action badge in its typeface, at its size, anchored to the corner, and gives
 * no way to move or restyle its geometry — so putting the count there means it
 * is rendered by the platform at every scale, on every platform theme, and
 * cannot be drawn twice or drift out of alignment. The icon is then only
 * responsible for the silhouette and the state colour. See docs/SPEC.md §3.
 *
 * It is also the only thing that talks to pages. The in-page toast is drawn by a
 * content script, but that script holds no state and no copy: the worker sends
 * it a finished message with the text and colours already resolved. So the
 * decision to speak is taken here, in the one place that knows the state.
 *
 * Fully event-driven. There is no polling of any kind.
 */

import {
  getState,
  shouldShowToast,
  TOAST_DEBOUNCE_MS,
  TOAST_DELIVERY_BACKOFF_MS,
  TOAST_MISS_WINDOW_MS,
} from '../shared/state.js';
import { TOOLBAR_ICON_SIZE, renderShape } from '../shared/shape-icon.js';

/**
 * When this worker last raised a toast, in memory.
 *
 * Deliberately not persisted. The cooldown is a guard against nagging, and a
 * worker only gets evicted after half a minute of doing nothing — by which point
 * any toast it raised is long past the four seconds the cooldown covers. So the
 * one case where forgetting it matters is one where it does not.
 */
let lastToastAt = null;

/**
 * How far the tab count has moved since the last toast decision.
 *
 * Null until a tab event says how far it moved, and the answer to a question that
 * used to need a remembered previous state: an event tells you its own size.
 * A tab was created, so the count went up by one; one was removed, so it went
 * down by one; one moved between windows, so it did not move at all. Add up the
 * events since the last decision and subtract from the count the browser reports,
 * and the state before the burst is known — with nothing remembered, which is
 * what makes it survive the worker being evicted.
 *
 * @type {number|null}
 */
let pendingDelta = null;

/**
 * The state as of the most recent refresh — what a toast would describe.
 */
let currentState = null;

/** Handle for the pending debounced toast decision, if one is scheduled. */
let toastTimer = null;

/**
 * The most recent crossing, kept briefly for a tab that was not ready for it.
 *
 * The tab that crosses a threshold is usually the tab the user just opened, and
 * that tab is still loading when the message goes out. Retrying covers a page
 * that is a moment behind; this covers a page that takes seconds, without
 * guessing how many seconds. Only the tabs the crossing was aimed at may collect
 * it, so a tab opened just afterwards stays quiet.
 *
 * It is a few seconds of memory about the user's own tab count — no page data,
 * nothing written to disk, and gone on its own.
 */
let missedCrossing = null;

/**
 * Deliver a crossing to one tab, and record that it landed.
 *
 * Two rules, both about not saying the wrong thing on the wrong page.
 *
 * A tab is only ever sent a crossing that was aimed at it. `aimed` is the set of
 * tabs the crossing was addressed to when it was decided, and a tab that was not
 * one of them is not a candidate however recently it turned up — otherwise a tab
 * opened a moment after a crossing, which crossed nothing, would announce itself
 * and collect a line about somebody else's threshold.
 *
 * And once a tab has it, nobody sends it again. The retry chain and the tab's
 * own arrival announcement are two routes to the same message and they race; the
 * first to arrive closes the other, or the page the user is looking at shows the
 * line twice.
 *
 * @param {{state: object, aimed: Set<number>, landed: Set<number>}} crossing
 * @param {number} tabId
 * @returns {Promise<boolean>} whether the tab now has the toast
 */
async function deliverCrossing(crossing, tabId) {
  const { state, aimed, landed } = crossing;
  if (landed.has(tabId)) return true;
  if (!aimed.has(tabId)) return false;
  const delivered = await deliverToTab(
    tabId,
    { type: 'tablox:toast', text: state.toast, color: state.color, textColor: state.badgeText },
    () => landed.has(tabId),
  );
  if (delivered) landed.add(tabId);
  return delivered;
}

/**
 * Count open tabs across all windows.
 *
 * Prefers a single `chrome.windows` round-trip; falls back to the tab list
 * length when the `windows` namespace is unavailable.
 *
 * @returns {Promise<number>}
 */
export async function countOpenTabs() {
  if (chrome.windows && typeof chrome.windows.getAll === 'function') {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.reduce((total, win) => total + (win.tabs?.length ?? 0), 0);
  }
  const tabs = await chrome.tabs.query({});
  return tabs.length;
}

/**
 * Paint the icon for a state.
 *
 * Chrome accepts a single `imageData` and rejects an array of them, so one image
 * is rendered and Chrome resamples it for whichever surface it needs. See
 * `TOOLBAR_ICON_SIZE` for why 32 is the right single size.
 *
 * The returned promise is handed back rather than swallowed: if Chrome rejects
 * the pixels, the caller needs to hear about it, because the alternative is a
 * toolbar silently stuck on the previous icon.
 *
 * The fill is `iconColor`, not the state's bright `color`: the shape has to be
 * visible against Chrome's light *and* dark toolbar, and the bright hues are
 * chosen for the badge, where they sit behind near-black text.
 *
 * @param {{ iconColor: string }} state
 * @returns {Promise<void>}
 */
export function applyIcon(state) {
  const { data, width, height } = renderShape({
    size: TOOLBAR_ICON_SIZE,
    fill: state.iconColor,
  });

  return chrome.action.setIcon({ imageData: new ImageData(data, width, height) });
}

/**
 * Paint the badge: the exact tab count, in the state's bright colour.
 *
 * The badge uses `color` rather than `iconColor`, because the badge is not
 * competing with a toolbar background — it is a self-contained pill with its own
 * background and its own near-black text, which is exactly the case the bright
 * saturated hues are good at.
 *
 * The text colour is not a style preference. Every state colour is bright, and
 * Chrome's default badge text is white, which on the yellow and green states is
 * close to invisible. `setBadgeTextColor` is declared by
 * `minimum_chrome_version: 110`, so it can be called unconditionally and Chrome
 * itself refuses to install the extension on anything older.
 *
 * Chrome renders at most four badge characters, so a five-digit count is clipped
 * by the platform. The exact count is still what gets sent, and the popup and
 * tooltip both report the true number.
 *
 * @param {{ color: string, badgeText: string, tabCount: number }} state
 * @returns {Promise<void>}
 */
export function applyBadge(state) {
  return Promise.all([
    chrome.action.setBadgeText({ text: String(state.tabCount) }),
    chrome.action.setBadgeBackgroundColor({ color: state.color }),
    chrome.action.setBadgeTextColor({ color: state.badgeText }),
  ]);
}

/**
 * Count tabs, resolve the state, and paint the toolbar.
 *
 * @returns {Promise<ReturnType<typeof getState>>}
 */
export async function refresh() {
  const tabCount = await countOpenTabs();
  const state = getState(tabCount);

  await Promise.all([
    applyIcon(state),
    applyBadge(state),
    chrome.action.setTitle({
      title: `Tablox — ${state.tabCount} ${state.tabCount === 1 ? 'tab' : 'tabs'} · ${state.label}`,
    }),
  ]);

  currentState = state;
  scheduleToastDecision();

  return state;
}

/**
 * Decide whether to raise a toast, once the tab events have settled.
 *
 * Every event restarts the timer, so a burst of opens is judged as one change.
 * The decision is made against `currentState` — where the user ended up — rather
 * than against whichever state happened to be current when the first event
 * landed.
 *
 * @returns {void}
 */
function scheduleToastDecision() {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    decideToast();
  }, TOAST_DEBOUNCE_MS);
}

/**
 * Raise a toast if the settled state differs from the one the tab count came
 * from.
 *
 * Where it came from is arithmetic, not memory: the count the browser reports,
 * less however far the events since the last decision moved it. A worker that
 * has just been woken has never seen a previous state and still gets this right,
 * which is the whole point — a worker that had to remember would say nothing on
 * every wake, and a service worker is woken constantly.
 *
 * `pendingDelta` is spent either way. A transition that was suppressed still
 * happened, and leaving it unspent would fold it into the next decision and
 * report a change that never occurred.
 *
 * @returns {void}
 */
function decideToast() {
  const state = currentState;
  if (!state) return;

  // Null means no tab event has been seen, so there is nothing to subtract and
  // no way to know what the count was before. Recording a baseline and saying
  // nothing is the only safe reading — this is the install, the browser starting
  // up, and the worker's own first breath.
  const previousId =
    pendingDelta === null
      ? null
      : getState(Math.max(1, state.tabCount - pendingDelta)).id;
  pendingDelta = null;

  if (shouldShowToast(previousId, state.id, { lastShownAt: lastToastAt, now: Date.now() })) {
    // Held so a tab that was not ready can still collect it. The tab that just
    // crossed is, nine times in ten, the tab that is still loading.
    const crossing = { state, at: Date.now(), aimed: new Set(), landed: new Set() };
    missedCrossing = crossing;

    // Not awaited: the toolbar is already correct, and holding its paint on a
    // message to somebody else's tab would make the icon feel slow.
    pushToast(crossing)
      .then((delivered) => {
        if (delivered > 0) lastToastAt = Date.now();
      })
      .catch(() => {});
  }
}

/**
 * Hand a crossing to a tab that announced itself after the fact.
 *
 * A content script registers at `document_idle` and says so. If a toast was due
 * in the meantime, this is the moment to deliver it — which is the difference
 * between a line that greets you as the page appears and one that turns up
 * several seconds later, long after it made sense.
 *
 * The offer is not consumed by the first tab to claim it. A burst of opens means
 * several pages loading at once, and the one that happens to finish first is
 * often a background tab; letting it take the line would leave the tab actually
 * on screen without it. It expires on its own instead.
 *
 * @param {{tab?: {id: number}}} sender
 * @returns {void}
 */
function offerMissedCrossing(sender) {
  if (!missedCrossing || !sender?.tab?.id) return;

  if (Date.now() - missedCrossing.at >= TOAST_MISS_WINDOW_MS) {
    missedCrossing = null;
    return;
  }

  const crossing = missedCrossing;
  deliverCrossing(crossing, sender.tab.id).then((delivered) => {
    if (delivered > 0) lastToastAt = Date.now();
  });
}

/**
 * Send a toast to the frontmost tab of every window.
 *
 * Foreground tabs only. A toast is a nudge to the person currently looking at
 * the screen, so pushing it to background tabs would mean saying it to tabs
 * nobody is in — and would put a line of text over pages the user is not
 * currently reading.
 *
 * Tabs we cannot reach are expected, not exceptional: `chrome://` pages, the
 * Web Store, other extensions' pages, and anything still loading all refuse
 * content scripts. Every one of those refusals is swallowed, because a tab
 * that cannot show a toast is not a failure of anything.
 *
 * @param {{state: ReturnType<typeof getState>, aimed: Set<number>, landed: Set<number>}} crossing
 * @returns {Promise<number>} how many tabs accepted the toast
 */
export async function pushToast(crossing) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true });
  } catch {
    return 0;
  }

  for (const tab of tabs) crossing.aimed.add(tab.id);

  const delivered = await Promise.all(tabs.map((tab) => deliverCrossing(crossing, tab.id)));
  return delivered.filter(Boolean).length;
}

/**
 * Hand a toast to one tab, retrying while it declines.
 *
 * A refusal means one of two very different things, and the reply is the same
 * either way: try again in a moment. A tab still loading refuses because its
 * content script has not registered; a tab that can never host one refuses
 * forever, and the backoff schedule is what stops the retries being endless.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<boolean>} whether the tab eventually took it
 */
async function deliverToTab(tabId, message, hasLanded = () => false) {
  for (const wait of TOAST_DELIVERY_BACKOFF_MS) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // This tab may have collected the same crossing by another route while the
    // chain was sleeping — a content script that announced itself, most likely.
    // Sending again would raise the toast a second time on the same page, so the
    // chain stands down instead.
    if (hasLanded()) return true;
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      /* not listening yet, or never going to; the next attempt decides */
    }
  }
  return false;
}

/**
 * Repaint the toolbar, surfacing any failure.
 *
 * Refreshes are fire-and-forget, so a rejection here has no caller. Swallowing
 * it silently would leave the toolbar stuck on the previous icon with nothing
 * in the console to explain why, so it is logged instead.
 *
 * @returns {void}
 */
function scheduleRefresh(delta = 0) {
  pendingDelta = (pendingDelta ?? 0) + delta;
  refresh().catch((error) => {
    console.warn('Tablox: could not refresh the toolbar —', error);
  });
}

// Each event, and what it did to the tab count. A tab moving between windows
// fires onAttached and onDetached and leaves the total alone, so both are zero.
const TAB_EVENTS = [
  [chrome.tabs.onCreated, 1],
  [chrome.tabs.onRemoved, -1],
  [chrome.tabs.onAttached, 0],
  [chrome.tabs.onDetached, 0],
];

for (const [event, delta] of TAB_EVENTS) {
  event.addListener(() => scheduleRefresh(delta));
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'tablox:ready') offerMissedCrossing(sender);
});

chrome.runtime.onStartup.addListener(scheduleRefresh);
chrome.runtime.onInstalled.addListener(scheduleRefresh);

// A service worker is terminated by Chrome and revived on the next event, so the
// toolbar is recomputed on every wake rather than restored from storage.
scheduleRefresh();
