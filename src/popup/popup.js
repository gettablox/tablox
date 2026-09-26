/**
 * Tablox popup.
 *
 * Reads the live tab count, resolves the state through the shared state
 * module, and renders three things: the count, the state, one short
 * explanation. Nothing else.
 *
 * The popup is read-only with respect to the toolbar — the service worker is
 * the sole writer of the icon, badge, and title.
 */

import { getState } from '../shared/state.js';

/**
 * Count open tabs across all windows.
 *
 * Uses the same bare `chrome.tabs.query({})` as the service worker: the array
 * length is the only thing read, so no URL, title, or page content is touched.
 *
 * @returns {Promise<number>}
 */
export async function readTabCount() {
  const tabs = await chrome.tabs.query({});
  return tabs.length;
}

/**
 * Render a resolved state into the popup DOM.
 *
 * @param {Document} doc
 * @param {ReturnType<typeof getState>} state
 */
export function render(doc, state) {
  doc.getElementById('count').textContent = String(state.tabCount);
  doc.getElementById('state').textContent = state.label;
  doc.getElementById('explanation').textContent = state.explanation;
  // iconColor, not the bright badge hue: the state colour appears here as a thin
  // rule and a small dot, and the popup follows the OS light/dark scheme, so it
  // needs the same colour the toolbar shape does.
  doc.getElementById('tablox').style.setProperty('--state-color', state.iconColor);
}

/**
 * Read the current tab count and paint the popup.
 *
 * @param {Document} doc
 * @returns {Promise<ReturnType<typeof getState>>}
 */
export async function init(doc) {
  const state = getState(await readTabCount());
  render(doc, state);
  return state;
}

// Self-initialise when running as the popup. Guarded so the module can be
// imported in tests, where neither the DOM nor a live extension exists.
if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.tabs) {
  init(document).catch(() => {});
}
