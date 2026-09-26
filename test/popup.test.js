/**
 * Popup tests.
 *
 * Drives the real popup module against a minimal fake DOM, so the rendered
 * output is checked without a browser or a DOM dependency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeChrome, installChrome, uninstallChrome } from './helpers/fake-chrome.js';
import { STATES, getState } from '../src/shared/state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = `file://${join(ROOT, 'src', 'popup', 'popup.js')}`;

let instance = 0;

/** The four elements popup.html provides, as a minimal fake document. */
function createFakeDocument() {
  const elements = {};
  for (const id of ['tablox', 'count', 'state', 'explanation']) {
    elements[id] = {
      id,
      textContent: '',
      style: {
        properties: {},
        setProperty(name, value) {
          this.properties[name] = value;
        },
      },
    };
  }
  return {
    elements,
    getElementById: (id) => {
      assert.ok(elements[id], `popup.html is missing #${id}`);
      return elements[id];
    },
  };
}

/** Load a fresh popup module with `tabCount` tabs open. */
async function openPopup(tabCount) {
  installChrome(createFakeChrome({ windowTabCounts: [tabCount] }));
  const module = await import(`${POPUP}?instance=${(instance += 1)}`);
  const doc = createFakeDocument();
  const state = await module.init(doc);
  return { doc, state, module };
}

test.after(uninstallChrome);

/**
 * Remove comments so prose about the code is not mistaken for the code.
 * Only whole-line and block comments are handled, which is all these files use.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

test('renders count, state, and one explanation', async () => {
  const { doc, state } = await openPopup(3);

  assert.equal(doc.elements.count.textContent, '3');
  assert.equal(doc.elements.state.textContent, 'Focused');
  assert.equal(
    doc.elements.explanation.textContent,
    'Your browser context is light, with little to keep track of.',
  );
  assert.equal(state.id, 'focused');
});

test('renders the specified copy for every example state', async () => {
  const expected = {
    3: [
      'Focused',
      'Your browser context is light, with little to keep track of.',
    ],
    6: [
      'Growing',
      'More information is building up in your browser context.',
    ],
    9: [
      'Crowded',
      'More information is making it harder to quickly find what you need.',
    ],
    12: [
      'Fragmented',
      'Different pages and tasks are competing for your attention.',
    ],
    13: [
      'Overloaded',
      'There is a lot to organize, find, and return to.',
    ],
  };

  for (const [count, [label, explanation]] of Object.entries(expected)) {
    const { doc } = await openPopup(Number(count));

    assert.equal(doc.elements.count.textContent, count, `${count} count`);
    assert.equal(doc.elements.state.textContent, label, `${count} label`);
    assert.equal(doc.elements.explanation.textContent, explanation, `${count} explanation`);
  }
});

test('the popup uses the shared state module, not its own thresholds', async () => {
  for (const state of STATES) {
    for (const count of [state.minTabs, state.maxTabs].filter((n) => n !== null)) {
      const { doc } = await openPopup(count);
      assert.equal(doc.elements.state.textContent, getState(count).label, `${count} tabs`);
    }
  }
});

test('the state colour reaches the popup as a CSS custom property', async () => {
  for (const count of [3, 4, 6, 7, 11, 12]) {
    const { doc } = await openPopup(count);
    const properties = doc.elements.tablox.style.properties;
    assert.equal(properties['--state-color'], getState(count).iconColor, `${count} tabs colour`);
  }
});

test('reads only the tab count — never a URL, title, or page content', async () => {
  const { module } = await openPopup(5);
  assert.equal(await module.readTabCount(), 5);

  const source = readFileSync(join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
  for (const forbidden of ['.url', '.title', 'favIconUrl', 'window.', 'document.cookie']) {
    assert.ok(!source.includes(forbidden), `popup references ${forbidden}`);
  }
});

test('shows zero tabs rather than a blank or misleading reading', async () => {
  const chrome = createFakeChrome({ windowTabCounts: [1] });
  installChrome(chrome);
  const module = await import(`${POPUP}?instance=${(instance += 1)}`);

  await chrome.closeTab((await chrome.tabs.query({}))[0].id);
  const doc = createFakeDocument();
  await module.init(doc);

  assert.equal(doc.elements.count.textContent, '0');
  assert.equal(doc.elements.state.textContent, 'Focused');
});

test('the popup carries no gamification, scoring, or AI surface', async () => {
  const files = ['popup.html', 'popup.css', 'popup.js'].map((name) =>
    stripComments(readFileSync(join(ROOT, 'src', 'popup', name), 'utf8')),
  );
  const source = files.join('\n').toLowerCase();

  const banned = [
    'score',
    'streak',
    'achievement',
    'badge',
    'level',
    'points',
    'goal',
    'challenge',
    'reward',
    'notification',
    'sound',
    'ai',
    'recommend',
    'suggest',
    'close tabs',
    'auto',
  ];

  // Word-boundary matches: a bare substring test would flag "ai" inside
  // "available" and tell us nothing.
  for (const word of banned) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    assert.ok(!pattern.test(source), `popup contains "${word}"`);
  }

  // No scripts or frames beyond the popup's own module.
  assert.equal((source.match(/<script/g) ?? []).length, 1, 'exactly one script tag');
  assert.ok(!source.includes('<iframe'), 'popup embeds no frame');
  assert.ok(!source.includes('http://') && !source.includes('https://'), 'no external URLs');
});
