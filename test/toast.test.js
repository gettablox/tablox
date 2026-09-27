/**
 * Threshold toast tests.
 *
 * The toast is the one part of Tablox that speaks unprompted, so these cover
 * three things: that it stays quiet (the overwhelming majority of tab events
 * change nothing), that it says the right thing when it does speak, and that it
 * degrades quietly on the tabs where it cannot be shown at all.
 *
 * The content script itself is not exercised here — it needs a real DOM, a
 * shadow root, and the Web Animations API. It is verified end to end in real
 * Chrome by `npm run verify:chrome`. What is verified here is everything that
 * decides *whether* and *what*: the copy, the transition policy, and delivery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgementPattern } from './helpers/copy.js';
import {
  createFakeChrome,
  installChrome,
  uninstallChrome,
  importFresh,
  flush,
} from './helpers/fake-chrome.js';
import {
  STATES,
  getState,
  shouldShowToast,
  TOAST_DEBOUNCE_MS,
  TOAST_MIN_INTERVAL_MS,
  TOAST_DELIVERY_BACKOFF_MS,
  TOAST_MISS_WINDOW_MS,
} from '../src/shared/state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = `file://${join(ROOT, 'src', 'background', 'service-worker.js')}`;

let instance = 0;

test.after(uninstallChrome);

/** Expected copy, spelled out here so a change to the state table is visible. */
const EXPECTED_TOASTS = {
  focused: 'Clean slate. Enjoy it',
  growing: 'A few tabs never hurt',
  crowded: 'Things are starting to pile up',
  fragmented: 'Tab archaeology begins',
  overloaded: 'The browser has entered its archival era',
};

/**
 * The same table, read downwards.
 *
 * Spelled out separately rather than derived, so that giving the two columns the
 * same line by accident is visible here instead of quietly shipping.
 */
const EXPECTED_CLOSE_TOASTS = {
  focused: 'Clean slate. Enjoy it',
  growing: 'Making some room',
  crowded: 'The pile is shrinking',
  fragmented: 'The excavation continues',
  overloaded: 'The archive is shrinking',
};

/** Both columns of the table, as `[state, direction, line]`. */
const everyLine = () =>
  STATES.flatMap((state) => [
    [state, 'opening', state.toast],
    [state, 'closing', state.toastClose],
  ]);

/**
 * Boot the service worker against a fake browser.
 *
 * @param {{windowTabCounts?: number[]}} [options]
 * @returns {Promise<{chrome: object, module: object}>}
 */
async function boot(options = {}) {
  const chrome = createFakeChrome(options);
  installChrome(chrome);
  // A fresh module per test, so the worker's in-memory baseline does not leak
  // between them — that baseline is deliberately per-worker-lifetime.
  const module = await importFresh(WORKER, (instance += 1));
  await flush();
  return { chrome, module };
}

/** Wait out the debounce window, plus a margin for the timer to fire. */
const settle = () =>
  new Promise((resolve) => setTimeout(resolve, TOAST_DEBOUNCE_MS + 40));

/**
 * Wait for a condition, rather than for a fixed time.
 *
 * Delivery can legitimately take seconds when a tab is still loading, so a test
 * that asserts on it has to wait on the outcome instead of on the clock.
 *
 * @param {() => boolean} condition
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(condition, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return condition();
}

/** Every toast text the worker has sent, oldest first. */
const toastTexts = (chrome) => chrome.messages().map((entry) => entry.message.text);

/**
 * How long a whole delivery schedule takes, from decision to last attempt.
 */
const RETRY_SPAN_MS = TOAST_DELIVERY_BACKOFF_MS.reduce((total, wait) => total + wait, 0);

/**
 * Wait out an entire delivery schedule, so no timer outlives the test.
 *
 * A tab that refuses every message is retried until the schedule runs out, and
 * the last attempt lands `RETRY_SPAN_MS` after the decision. Waiting that out is
 * the only reliable way to be sure the chain has finished: watching the attempt
 * count hold still looks like it works and is not, because the gaps between
 * attempts are longer than any quiet window you would wait for. A chain that
 * outlives its test records itself against the next test's fake browser, where it
 * fails something unrelated.
 *
 * Timed off `performance.now()` rather than the clock the worker reads, because
 * one of these tests deliberately moves that clock.
 *
 * @returns {Promise<void>}
 */
const waitOutDelivery = () =>
  new Promise((resolve) =>
    setTimeout(resolve, TOAST_DEBOUNCE_MS + RETRY_SPAN_MS + 60),
  );

// --- the copy ---------------------------------------------------------------

test('each state has exactly the specified line', () => {
  const actual = Object.fromEntries(STATES.map((state) => [state.id, state.toast]));
  assert.deepEqual(actual, EXPECTED_TOASTS);
});

test('each state has exactly the specified line for the other direction', () => {
  const actual = Object.fromEntries(STATES.map((state) => [state.id, state.toastClose]));
  assert.deepEqual(actual, EXPECTED_CLOSE_TOASTS);
});

test('the two directions only share a line where there is nothing to say', () => {
  // At the bottom of the table there is no pile to shrink and no room to make, so
  // one line for both is the right copy rather than a missing second one. Every
  // state above it has to speak differently: the whole point of the second column
  // is that closing tabs and opening them are different events.
  for (const state of STATES) {
    const same = state.toast === state.toastClose;
    assert.equal(
      same,
      state.id === 'focused',
      `${state.id}: ${same ? 'shares' : 'differs'} between the two directions`,
    );
  }
});

test('the toast is the bare line, not a quoted one', () => {
  // The copy arrived wrapped in typographic quotes so it could sit safely in a
  // document. Those brackets are scaffolding and must not reach a page. An
  // apostrophe inside a word is not a bracket, so `It's` is left alone.
  for (const [state, direction, toast] of everyLine()) {
    const label = `${state.id} ${direction} toast`;
    assert.ok(!/^["“”']/.test(toast), `${label} opens with a quote`);
    assert.ok(!/["“”']$/.test(toast), `${label} closes with a quote`);
    assert.doesNotMatch(toast, /["“”]/, `${label} contains a double quote`);

    // The toast is a line put over someone's work, not a sentence in a document,
    // so it no longer ends in a full stop — it is the shortest thing that still
    // reads as a complete thought. A question keeps its question mark, because
    // that is part of the line rather than a closing full stop.
    assert.doesNotMatch(toast, /\.$/, `${label} ends in a full stop`);
  }
});

test('the toast is one short line, so it cannot become a paragraph', () => {
  for (const [state, direction, toast] of everyLine()) {
    const label = `${state.id} ${direction} toast`;
    const words = toast.split(/\s+/).length;
    assert.ok(words <= 12, `${label} is ${words} words`);
    assert.ok(toast.length <= 64, `${label} is ${toast.length} characters`);
  }
});

test('nothing Tablox writes is a verdict on the user', () => {
  // The toast is blunter than the popup, so it needs the constraint more, not
  // less. It shares the popup's vocabulary rather than inventing its own.
  const judgement = judgementPattern();

  for (const [state, direction, toast] of everyLine()) {
    assert.doesNotMatch(state.explanation, judgement, `${state.id} explanation`);
    assert.doesNotMatch(toast, judgement, `${state.id} ${direction} toast`);
  }
});

// --- transition policy ------------------------------------------------------

test('a transition into a new state is worth a toast', () => {
  assert.equal(shouldShowToast('focused', 'growing'), true);
});

test('staying in the same state is not', () => {
  assert.equal(shouldShowToast('growing', 'growing'), false);
  assert.equal(shouldShowToast('overloaded', 'overloaded'), false);
});

test('the first refresh is a baseline, not a change', () => {
  // No previous state means the worker has just started. Speaking here would
  // mean a toast on every MV3 wake.
  assert.equal(shouldShowToast(null, 'focused'), false);
  assert.equal(shouldShowToast(undefined, 'overloaded'), false);
});

test('a downward transition speaks too', () => {
  assert.equal(shouldShowToast('overloaded', 'fragmented'), true);
  assert.equal(shouldShowToast('crowded', 'growing'), true);
});

test('a toast just shown suppresses the next one inside the cooldown', () => {
  const at = 1_000_000;
  assert.equal(
    shouldShowToast('growing', 'crowded', { lastShownAt: at, now: at + TOAST_MIN_INTERVAL_MS - 1 }),
    false,
  );
  assert.equal(
    shouldShowToast('growing', 'crowded', { lastShownAt: at, now: at + TOAST_MIN_INTERVAL_MS }),
    true,
  );
});

test('the cooldown is measured from the last toast, not from boot', () => {
  assert.equal(shouldShowToast('focused', 'growing', { lastShownAt: null }), true);
  assert.equal(shouldShowToast('focused', 'growing', {}), true);
});

// --- behaviour against a fake browser ---------------------------------------

test('3 → 4 tabs raises the Growing line', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();
  assert.deepEqual(toastTexts(chrome), [], 'startup must not speak');

  chrome.openTab();
  await settle();

  assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
});

test('more tabs inside the same state raise nothing', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [4] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 5
  await settle();
  chrome.openTab(); // 6
  await settle();

  assert.deepEqual(toastTexts(chrome), [], 'a same-state change must stay quiet');
});

test('reaching 7 raises the Crowded line', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [6] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 7
  await settle();

  assert.deepEqual(toastTexts(chrome), ['Things are starting to pile up']);
});

test('reaching 10 raises the Fragmented line', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [9] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 10
  await settle();

  assert.deepEqual(toastTexts(chrome), ['Tab archaeology begins']);
});

test('reaching 13 raises the Overloaded line', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [12] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 13
  await settle();

  assert.deepEqual(toastTexts(chrome), ['The browser has entered its archival era']);
});

test('a burst of opens raises one toast, for the state it settled on', async () => {
  // The specified 3 → 4 → 5 → 6 → 7 case. Four events, two thresholds crossed,
  // and the user only ever sees where they ended up.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 4
  chrome.openTab(); // 5
  chrome.openTab(); // 6
  chrome.openTab(); // 7
  await settle();

  assert.deepEqual(
    toastTexts(chrome),
    ['Things are starting to pile up'],
    'a burst should produce one line, and it should be the final state’s',
  );
});

test('crossing down speaks, and speaks the line for closing', async () => {
  // The bug this column exists for. Closing tabs is a different event from opening
  // them, and the state cannot tell the two apart on its own: 12 tabs means the
  // same thing whether they arrived or were left behind. Only the worker knows,
  // from the sign of the delta, which one this was.
  const { chrome, module } = await boot({ windowTabCounts: [13] });
  await module.refresh();
  await settle();

  chrome.closeTab((await chrome.tabs.query({}))[0].id); // 12
  await settle();

  assert.deepEqual(toastTexts(chrome), ['The excavation continues']);
});

test('every threshold says the closing line when it is crossed downwards', async () => {
  // One case per state that has a distinct line, so a state whose two lines were
  // swapped cannot pass. The last case crosses three thresholds on the way down,
  // and must still speak for the state it landed in.
  const cases = [
    { from: 4, close: 1, line: 'Clean slate. Enjoy it' }, // → 3
    { from: 7, close: 1, line: 'Making some room' }, // → 6
    { from: 10, close: 1, line: 'The pile is shrinking' }, // → 9
    { from: 13, close: 1, line: 'The excavation continues' }, // → 12
    { from: 20, close: 10, line: 'The excavation continues' }, // → 10
  ];

  for (const { from, close, line } of cases) {
    const { chrome, module } = await boot({ windowTabCounts: [from] });
    await module.refresh();
    await settle();

    for (let count = 0; count < close; count += 1) {
      chrome.closeTab((await chrome.tabs.query({}))[0].id);
    }
    await settle();

    assert.deepEqual(
      toastTexts(chrome),
      [line],
      `${from} − ${close} should speak the line for closing`,
    );
  }
});

test('a fall is not described with a line about rising', async () => {
  // The specific failure the second column exists to prevent: Crowded's opening
  // line put on screen at the moment the user is tidying up. Correct copy in the
  // wrong column still reads as a product that has lost track of what you did.
  const { chrome, module } = await boot({ windowTabCounts: [7] });
  await module.refresh();
  await settle();

  chrome.closeTab((await chrome.tabs.query({}))[0].id); // 6
  await settle();

  const spoken = toastTexts(chrome);
  assert.deepEqual(spoken, ['Making some room']);
  assert.notEqual(spoken[0], getState(7).toast, 'a fall was described as a rise');
});

test('a burst that both opens and closes speaks about the way it ended up', async () => {
  // Four closed, one opened: the net movement is downwards, and that is the
  // direction the line has to describe — not the last event to fire, which here
  // is an open.
  const { chrome, module } = await boot({ windowTabCounts: [8] });
  await module.refresh();
  await settle();

  for (const tab of (await chrome.tabs.query({})).slice(0, 4)) {
    chrome.closeTab(tab.id); // 8 → 4
  }
  chrome.openTab(); // 5
  await settle();

  assert.deepEqual(
    toastTexts(chrome),
    ['Making some room'],
    'the direction should be the net one, not the last event’s',
  );
});

test('a rise and a fall inside one state stay quiet in both directions', async () => {
  // The direction must not be a way to say something about a change that crossed
  // nothing: 4 → 6 → 5 is all Growing.
  const { chrome, module } = await boot({ windowTabCounts: [4] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 5
  chrome.openTab(); // 6
  chrome.closeTab((await chrome.tabs.query({}))[0].id); // 5
  await settle();

  assert.deepEqual(toastTexts(chrome), [], 'a same-state change must stay quiet');
});

test('only foreground tabs are addressed, in every window', async () => {
  // 3 + 6 = 9 tabs is Crowded; opening one more is Fragmented, so this both
  // crosses a threshold and puts two windows' worth of foreground tabs in play.
  const { chrome, module } = await boot({ windowTabCounts: [3, 6] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 10 in the first window
  await settle();

  const activeIds = (await chrome.tabs.query({ active: true })).map((tab) => tab.id);
  const allIds = (await chrome.tabs.query({})).map((tab) => tab.id);
  const sentIds = chrome.messages().map((entry) => entry.tabId);

  assert.equal(activeIds.length, 2, 'both windows have a foreground tab');
  assert.deepEqual(
    [...sentIds].sort((a, b) => a - b),
    [...activeIds].sort((a, b) => a - b),
    'exactly the foreground tabs, no more and no fewer',
  );

  const background = allIds.filter((id) => !activeIds.includes(id));
  assert.ok(background.length > 0, 'the setup should have background tabs to avoid');
  for (const id of background) {
    assert.ok(!sentIds.includes(id), `a background tab (${id}) was addressed`);
  }
});

test('the toast carries the state’s colour and its matching text colour', async () => {
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  chrome.openTab(); // 4, Growing
  await settle();

  const { message } = chrome.messages().at(-1);
  const growing = getState(4);
  assert.equal(message.type, 'tablox:toast');
  assert.equal(message.text, growing.toast);
  assert.equal(message.color, growing.color, 'toast background is the badge colour');
  assert.equal(message.textColor, growing.badgeText, 'toast text is the badge text colour');
});

test('a tab that is still loading gets the toast once it is listening', async () => {
  // The common case, and the one that broke it: opening a tab makes that tab the
  // foreground tab, and it is still loading. Its content script is not registered
  // yet, so the first delivery is refused — on the very page the user is looking
  // at. Without a retry the toast is simply lost.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const opened = chrome.openTab(); // 4, and the foreground tab
  chrome.slowToListen(opened.id, 2); // refuses twice, then starts listening
  await settle();
  const delivered = await waitFor(() => toastTexts(chrome).length > 0);

  assert.ok(delivered, 'the worker stopped trying before the tab was ready');
  assert.deepEqual(
    toastTexts(chrome),
    ['A few tabs never hurt'],
    'the toast was dropped on a page that had not finished loading',
  );
});

test('delivery gives up eventually rather than retrying forever', async () => {
  // A tab that never becomes ready — a chrome:// page, a dead connection — must
  // not keep the worker awake. The backoff is finite, and that is the only thing
  // stopping this.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const expected = TOAST_DELIVERY_BACKOFF_MS.length;
  const opened = chrome.openTab();
  chrome.blockContentScripts(opened.id);
  await settle();

  // The crossing itself triggers the delivery, so there is no need to send one
  // by hand and no risk of counting the same work twice.
  const finished = await waitFor(() => chrome.attempts().length >= expected);
  assert.ok(finished, `only ${chrome.attempts().length} of ${expected} attempts were made`);

  // The property that matters is that it stops. Counting up to the schedule and
  // walking away is bounded; counting up and carrying on is a poll.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = chrome.attempts().length;
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.deepEqual(toastTexts(chrome), [], 'nothing was delivered');
  assert.equal(after, expected, `tried ${after} times, not ${expected}`);
  assert.equal(
    chrome.attempts().length,
    after,
    'the worker is still retrying a tab that will never be ready',
  );
});

test('a worker woken from eviction still announces the crossing', async () => {
  // The bug this whole exercise started from. MV3 evicts a service worker after
  // half a minute of doing nothing, so most crossings are announced by a worker
  // that has never seen the state before it. Remembering the previous state
  // cannot survive that, and reading the new one as a baseline means the toast
  // never appears — which is exactly what it did.
  //
  // A fresh worker, told nothing but the event that woke it.
  const chrome = createFakeChrome({ windowTabCounts: [3] });
  installChrome(chrome);
  const module = await importFresh(WORKER, (instance += 1));
  await flush();

  chrome.openTab(); // 4, and the only thing this worker hears about
  const got = await waitFor(() => toastTexts(chrome).length > 0);

  assert.ok(got, 'a worker with no memory of the previous state stayed silent');
  assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
});

test('a worker that has seen no events at all stays silent', async () => {
  // The other half of the same rule, and the one that must not regress: install,
  // browser startup and the worker's own first refresh all look like this, and
  // every one of them should keep its mouth shut.
  const chrome = createFakeChrome({ windowTabCounts: [13] });
  installChrome(chrome);
  const module = await importFresh(WORKER, (instance += 1));
  await flush();
  await settle();

  const state = await module.refresh();
  assert.equal(state.id, 'overloaded');
  assert.deepEqual(toastTexts(chrome), [], 'a baseline was announced as a crossing');
});

test('a tab that announces itself late still gets the crossing', async () => {
  // The shape of the real failure: the tab opens, the crossing is decided, the
  // message goes nowhere, and the page finishes loading a moment later. Polling
  // cannot fix this in general, so the tab asks for the toast it missed.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const opened = chrome.openTab(); // 4, still loading
  chrome.slowToListen(opened.id, 99); // out of reach of the retry
  await settle();
  assert.deepEqual(toastTexts(chrome), [], 'nothing while the page is loading');

  chrome.tabBecomesReady(opened.id);
  const got = await waitFor(() => toastTexts(chrome).length > 0);

  assert.ok(got, 'the tab that announced itself was never given the toast');
  assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
});

test('a tab readied long after the crossing still gets it', async () => {
  // The case that lost the toast in the field. Opening a tab crosses the
  // threshold, and for a while that tab is the New Tab page, which takes no
  // content script and so never announces itself. The offer is not waiting on
  // the network — it is waiting on a person to type a URL, which takes longer
  // than the four seconds the offer used to last. The line arrived on a page
  // that had every right to it and was told nothing.
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;

  try {
    const { chrome, module } = await boot({ windowTabCounts: [3] });
    await module.refresh();
    await settle();

    const opened = chrome.openTab(); // 4, out of reach of the retry
    chrome.slowToListen(opened.id, 99);
    await waitOutDelivery();
    assert.deepEqual(toastTexts(chrome), [], 'the retry alone cannot deliver here');

    // Long enough that a four-second offer would have expired and been silent.
    offset += 15000;
    chrome.tabBecomesReady(opened.id);
    const got = await waitFor(() => toastTexts(chrome).length > 0);

    assert.ok(got, 'a tab that settled 15s after crossing was never given the toast');
    assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
  } finally {
    Date.now = real;
  }
});

test('an announcement long after the crossing gets nothing', async () => {
  // Otherwise a tab opened minutes later would surface a line about an event
  // the user has long since stopped thinking about. The clock is moved rather
  // than waited out, so this costs nothing.
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;

  try {
    const { chrome, module } = await boot({ windowTabCounts: [3] });
    await module.refresh();
    await settle();

    const opened = chrome.openTab();
    chrome.slowToListen(opened.id, 99);
    // Let the retry finish first. Otherwise the announcement is not the only
    // thing that could deliver, and the test would pass or fail for the wrong
    // reason.
    await waitOutDelivery();

    offset += TOAST_MISS_WINDOW_MS + 1000;
    const attemptsBefore = chrome.attempts().length;
    chrome.tabBecomesReady(opened.id);
    await settle();

    assert.deepEqual(toastTexts(chrome), [], 'a stale crossing was announced');
    assert.equal(
      chrome.attempts().length,
      attemptsBefore,
      'a stale announcement should not even be attempted',
    );
  } finally {
    Date.now = real;
  }
});

test('a tab opened just after a crossing is not given it', async () => {
  // The crossing is still "current" for a few seconds, and any tab that announces
  // itself in that time can hear about it. Only the tab the crossing was aimed at
  // should — otherwise a tab opened straight after, which crossed nothing, greets
  // the user with a line about somebody else's threshold.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const crossing = chrome.openTab(); // 4, and the crossing is addressed to it
  chrome.slowToListen(crossing.id, 99);
  await settle();

  const bystander = chrome.openTab(); // 5, crosses nothing
  chrome.tabBecomesReady(bystander.id);
  await settle();

  assert.deepEqual(
    toastTexts(chrome).filter((text) => text === 'A few tabs never hurt'),
    [],
    'a bystander tab collected a crossing that was not its own',
  );

  // And the tab that was actually addressed still gets it.
  chrome.tabBecomesReady(crossing.id);
  const got = await waitFor(() => toastTexts(chrome).length > 0);
  assert.ok(got, 'the addressed tab was skipped');
  assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
});

test('in a burst, only the tab in front is given the crossing', async () => {
  // Two tabs opening together settle on one toast, and the foreground tab is the
  // one the user is looking at. The tab it displaced is a background tab now, and
  // a background tab announcing itself later is not owed the line — announcing
  // readiness is not a claim to every toast raised in the last few seconds.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const first = chrome.openTab();
  chrome.slowToListen(first.id, 99);
  const front = chrome.openTab(); // the one left in front
  chrome.slowToListen(front.id, 99);
  await settle();

  chrome.tabBecomesReady(first.id);
  await settle();
  assert.deepEqual(toastTexts(chrome), [], 'a background tab was given the toast');

  chrome.tabBecomesReady(front.id);
  const got = await waitFor(() => toastTexts(chrome).length > 0);

  assert.ok(got, 'the foreground tab was never given the toast');
  assert.deepEqual(toastTexts(chrome), ['A few tabs never hurt']);
});

test('a page that answers the announcement is not toasted again by the retry', async () => {
  // Two routes carry the same toast to the same tab: the retry chain and the
  // arrival announcement. Whichever wins has to close the other, or the page the
  // user is looking at shows the line twice.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  const opened = chrome.openTab();
  chrome.slowToListen(opened.id, 2); // refuses the first two attempts, then hears
  await waitOutDelivery();

  // The chain has already succeeded by now, so the announcement has to find the
  // work already done rather than raise a second one.
  chrome.tabBecomesReady(opened.id);
  await settle();

  assert.deepEqual(
    toastTexts(chrome),
    ['A few tabs never hurt'],
    'the toast was raised more than once on one page',
  );
});

test('the content script announces itself, and carries nothing with it', async () => {
  const source = readFileSync(join(ROOT, 'src', 'content', 'toast.js'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.match(code, /type:\s*'tablox:ready'/, 'the content script must announce itself');
  // Chrome sends the sender, so the worker already knows which tab this is. The
  // announcement exists to say "I am here", not to describe the page.
  const announcement = code.slice(code.indexOf("'tablox:ready'"));
  const statement = announcement.slice(0, announcement.indexOf(';'));
  assert.doesNotMatch(
    statement,
    /url|tab\.url|title|favIcon|pendingUrl|\burl\b/,
    'the announcement carries page data',
  );
});

test('a tab that cannot host a content script is skipped, not fatal', async () => {
  // chrome:// pages, the Web Store and a tab still loading all refuse. The toast
  // is a nicety; it must never be the reason a refresh fails.
  const { chrome, module } = await boot({ windowTabCounts: [3] });
  await module.refresh();
  await settle();

  // Open the tab first, because opening it is what makes it the foreground
  // tab — the one the toast will be sent to. Blocking before the open would
  // block a tab that is no longer in the way.
  const opened = chrome.openTab(); // 4
  chrome.blockContentScripts(opened.id);
  await settle();

  assert.deepEqual(toastTexts(chrome), [], 'nothing was delivered, and nothing threw');
  await waitOutDelivery();

  // And the reason nothing was delivered is not that the count went wrong: the
  // toolbar still crossed into Growing, and the refusal did not take it down.
  const state = await module.refresh();
  assert.equal(state.tabCount, 4);
  assert.equal(getState(state.tabCount).id, 'growing', 'the toolbar still updated');
});

// --- the content script, by inspection --------------------------------------

test('the toast cannot block the page it is drawn on', () => {
  const source = readFileSync(join(ROOT, 'src', 'content', 'toast.js'), 'utf8');
  assert.match(source, /pointer-events:none/, 'the host must be click-through');
  assert.match(source, /position:fixed/, 'the toast must not affect page layout');
  assert.ok(!/addEventListener\(\s*['"](click|mousedown|keydown)/.test(source),
    'the toast must not listen for input');
  assert.ok(!/position:\s*absolute/.test(source), 'the toast must not be placed in the page flow');
});

test('the toast writes its text, never markup', () => {
  const source = readFileSync(join(ROOT, 'src', 'content', 'toast.js'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(code, /\.textContent\s*=/, 'the toast must set text via textContent');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code), 'the toast must not parse markup');
});

test('the toast is transient and always removes itself', () => {
  const source = readFileSync(join(ROOT, 'src', 'content', 'toast.js'), 'utf8');
  // Enter, a hold between roughly two and three seconds, then exit and removal.
  assert.match(source, /const HOLD_MS = (2[0-9]{3}|3[0-9]{3});/);
  assert.match(source, /host\.remove\(\)/, 'the host must be removed');
  assert.ok(!/setInterval/.test(source), 'nothing may re-show the toast');
});

test('the toast respects reduced-motion', () => {
  const source = readFileSync(join(ROOT, 'src', 'content', 'toast.js'), 'utf8');
  assert.match(source, /prefers-reduced-motion/, 'reduced motion must be honoured');
});
