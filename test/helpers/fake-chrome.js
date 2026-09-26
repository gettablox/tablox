/**
 * A minimal in-memory fake of the Chrome extension APIs Tablox uses.
 *
 * Models windows containing tabs, and the four tab events the service worker
 * subscribes to, so behaviour can be driven without a browser. Every
 * `chrome.action` call is recorded for assertions.
 *
 * `chrome.tabs.query` honours a filter, so `{ active: true }` returns only the
 * foreground tabs — the query the toast uses. `chrome.tabs.sendMessage` records
 * what was sent and can be made to reject for a given tab, which is how a
 * `chrome://` page or a tab still loading behaves: those refusals are expected,
 * and the worker has to survive every one of them.
 */

/** A tab event that can be dispatched, standing in for `chrome.tabs.onX`. */
class FakeEvent {
  constructor(name) {
    this.name = name;
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    for (const listener of this.listeners) listener(...args);
  }
}

/**
 * Build a fake `chrome` global.
 *
 * @param {{windowTabCounts?: number[], withWindowsApi?: boolean}} [options]
 *   `windowTabCounts` seeds the tab count per window (default: a single window
 *   with 1 tab). `withWindowsApi: false` omits `chrome.windows` to exercise the
 *   fallback path.
 */
export function createFakeChrome({ windowTabCounts = [1], withWindowsApi = true } = {}) {
  let nextTabId = 1;
  let nextWindowId = 1;

  const windows = windowTabCounts.map((count) => ({
    id: nextWindowId++,
    tabs: Array.from({ length: count }, () => ({ id: nextTabId++, active: false })),
  }));
  // One foreground tab per window, as Chrome would have after opening them.
  for (const win of windows) if (win.tabs[0]) win.tabs[0].active = true;

  /** Every `sendMessage` the worker made, in order. */
  const sentMessages = [];

  /** Every attempt, including the ones that were refused. */
  const attempts = [];

  const events = {
    onCreated: new FakeEvent('onCreated'),
    onRemoved: new FakeEvent('onRemoved'),
    onAttached: new FakeEvent('onAttached'),
    onDetached: new FakeEvent('onDetached'),
  };

  const action = {
    calls: {
      setIcon: [],
      setTitle: [],
      setBadgeText: [],
      setBadgeBackgroundColor: [],
      setBadgeTextColor: [],
    },
    setIcon: (details) => record('setIcon', details),
    setTitle: (details) => record('setTitle', details),
    setBadgeText: (details) => record('setBadgeText', details),
    setBadgeBackgroundColor: (details) => record('setBadgeBackgroundColor', details),
    setBadgeTextColor: (details) => record('setBadgeTextColor', details),
  };

  const runtime = {
    onStartup: new FakeEvent('onStartup'),
    onInstalled: new FakeEvent('onInstalled'),
    // Content scripts talking *to* the worker, which is the opposite direction
    // from the toasts the worker sends out.
    onMessage: new FakeEvent('onMessage'),
    sendMessage: () => Promise.resolve(),
  };

  function record(name, details) {
    action.calls[name].push(details);
    return Promise.resolve();
  }

  const allTabs = () => windows.flatMap((win) => win.tabs);

  const chrome = {
    tabs: {
      ...events,
      // Honours the filters the extension actually uses, so a test that asks for
      // the active tabs gets the active tabs rather than all of them.
      // `lastFocusedWindow` is not a tab property, so it is answered from the
      // window state instead of being matched against each tab.
      query: (filter = {}) =>
        Promise.resolve(
          allTabs().filter((tab) =>
            Object.entries(filter).every(([key, want]) => tab[key] === want),
          ),
        ),
      sendMessage: (tabId, message) => {
        const tab = allTabs().find((candidate) => candidate.id === tabId);
        attempts.push({ tabId, message });
        // Two different refusals, because they are two different situations: a
        // tab that has not injected its content script yet, and one that never
        // will. Only the first is worth retrying, and the worker cannot tell them
        // apart, which is why the backoff has to be finite.
        if (tab?.refuseTimes > 0) {
          tab.refuseTimes -= 1;
          return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        }
        if (tab?.noContentScript) {
          return Promise.reject(new Error('Receiving end does not exist.'));
        }
        sentMessages.push({ tabId, message });
        return Promise.resolve();
      },
    },
    action,
    runtime,
  };

  if (withWindowsApi) {
    chrome.windows = {
      getAll: () =>
        Promise.resolve(
          windows.map((win) => ({ id: win.id, tabs: win.tabs.map((tab) => ({ ...tab })) })),
        ),
    };
  }

  // --- helpers for driving scenarios -------------------------------------

  chrome.tabCount = () => allTabs().length;

  /** Current toolbar state as last reported to `chrome.action`. */
  chrome.toolbar = () => {
    const imageData = action.calls.setIcon.at(-1)?.imageData;
    return {
      // Chrome takes a single ImageData, not an array; normalise so tests can
      // treat the set uniformly and assert on its length.
      icons: imageData === undefined ? [] : Array.isArray(imageData) ? imageData : [imageData],
      title: action.calls.setTitle.at(-1)?.title,
      // Mirrors Chrome's own badge getters, including Chrome's default of '' when
      // nothing has been set, so tests read the badge the way Chrome would.
      badge: {
        text: action.calls.setBadgeText.at(-1)?.text ?? '',
        background: action.calls.setBadgeBackgroundColor.at(-1)?.color ?? '',
        textColor: action.calls.setBadgeTextColor.at(-1)?.color ?? '',
      },
    };
  };

  /**
   * Make a tab refuse content scripts, the way a `chrome://` page does.
   *
   * @param {number} tabId
   * @returns {void}
   */
  chrome.blockContentScripts = (tabId) => {
    const tab = allTabs().find((candidate) => candidate.id === tabId);
    if (tab) tab.noContentScript = true;
  };

  /**
   * A content script in `tabId` announcing that it is ready to receive.
   *
   * This is the moment a page finishes loading, and the only moment at which a
   * toast that was sent too early can still be delivered.
   *
   * @param {number} tabId
   * @returns {void}
   */
  chrome.tabBecomesReady = (tabId) => {
    // Announcing itself means the content script is running, so the tab is no
    // longer one that refuses messages. Left as-is, a tab set up to be out of
    // reach of the retry would still be deaf when the announcement arrives.
    const tab = allTabs().find((candidate) => candidate.id === tabId);
    if (tab) tab.refuseTimes = 0;
    runtime.onMessage.emit({ type: 'tablox:ready' }, { tab: { id: tabId } });
  };

  /**
   * Make a tab refuse the next `times` messages, then start listening.
   *
   * This is a tab that is still loading: its content script is registered at
   * `document_idle` and has not run yet. The tab that crosses a threshold is
   * almost always in exactly this state.
   *
   * @param {number} tabId
   * @param {number} times
   * @returns {void}
   */
  chrome.slowToListen = (tabId, times) => {
    const tab = allTabs().find((candidate) => candidate.id === tabId);
    if (tab) tab.refuseTimes = times;
  };

  /** Every message the worker has sent to a tab, oldest first. */
  chrome.messages = () => sentMessages.slice();

  /**
   * Every delivery attempt, refused ones included.
   *
   * This is how a test tells "gave up after trying" from "gave up without
   * trying", which is the difference between a bounded retry and a silent drop.
   */
  chrome.attempts = () => attempts.slice();

  /** Open a new tab in a window and fire `onCreated`. */
  chrome.openTab = (windowId = windows[0]?.id) => {
    const win = windows.find((candidate) => candidate.id === windowId);
    if (!win) throw new Error('unknown window in openTab');
    // A newly opened tab is the window's foreground tab, and the tab it
    // displaces is not. Chrome does this; a fake that does not is testing its
    // own assumptions instead of the extension.
    for (const existing of win.tabs) existing.active = false;
    const tab = { id: nextTabId++, active: true };
    win.tabs.push(tab);
    events.onCreated.emit(tab);
    return tab;
  };

  /** Close a tab and fire `onRemoved`. */
  chrome.closeTab = (tabId) => {
    for (const win of windows) {
      const index = win.tabs.findIndex((tab) => tab.id === tabId);
      if (index !== -1) {
        const [tab] = win.tabs.splice(index, 1);
        // A window always has a foreground tab, so closing the foreground one
        // hands the role to a survivor. Without this, a window can end up with
        // no active tab and `{ active: true }` matches nothing.
        if (tab.active && !win.tabs.some((candidate) => candidate.active)) {
          const successor = win.tabs.at(-1);
          if (successor) successor.active = true;
        }
        events.onRemoved.emit(tabId, { windowId: win.id, isWindowClosing: false });
        return;
      }
    }
    throw new Error(`no such tab: ${tabId}`);
  };

  /** Move a tab into another window, firing `onDetached` then `onAttached`. */
  chrome.moveTab = (tabId, toWindowId) => {
    const from = windows.find((win) => win.tabs.some((tab) => tab.id === tabId));
    const to = windows.find((win) => win.id === toWindowId);
    if (!from || !to) throw new Error('unknown window in moveTab');

    from.tabs = from.tabs.filter((tab) => tab.id !== tabId);
    events.onDetached.emit(tabId, { oldWindowId: from.id, newWindowId: to.id });

    to.tabs.push({ id: tabId });
    events.onAttached.emit(tabId, { newWindowId: to.id });
  };

  /** Add a window containing `count` tabs, without firing events. */
  chrome.addWindow = (count) => {
    const win = {
      id: nextWindowId++,
      tabs: Array.from({ length: count }, () => ({ id: nextTabId++ })),
    };
    windows.push(win);
    return win;
  };

  /** Close a window and every tab in it, as Chrome does. */
  chrome.closeWindow = (windowId) => {
    const index = windows.findIndex((win) => win.id === windowId);
    if (index === -1) throw new Error(`no such window: ${windowId}`);

    const [win] = windows.splice(index, 1);
    for (const tab of win.tabs) {
      events.onRemoved.emit(tab.id, { windowId, isWindowClosing: true });
    }
  };

  return chrome;
}

/**
 * A stand-in for the browser's `ImageData`, which the service worker uses to
 * hand pixel buffers to `setIcon`. Node has no such global.
 */
class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
    this.colorSpace = 'srgb';
  }
}

/**
 * Install a fake `chrome` as a global for the remainder of the test.
 *
 * It stays installed: the service worker resolves `chrome` at call time, and
 * its refreshes are asynchronous, so tearing the global down as soon as the
 * module has been imported would break them.
 *
 * @param {object} fakeChrome
 */
export function installChrome(fakeChrome) {
  globalThis.chrome = fakeChrome;
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = FakeImageData;
  }
}

/** Remove the fake `chrome` and `ImageData` globals. */
export function uninstallChrome() {
  delete globalThis.chrome;
  delete globalThis.ImageData;
}

/**
 * Import a module fresh, bypassing the ES module cache.
 *
 * Service workers run their side effects at module scope, so each scenario
 * needs its own module instance; the cache-busting query guarantees one.
 *
 * @template T
 * @param {string} specifier
 * @param {number} instance
 * @returns {Promise<T>}
 */
export function importFresh(specifier, instance) {
  return import(`${specifier}?instance=${instance}`);
}

/** Let queued microtasks settle so fire-and-forget refreshes complete. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
