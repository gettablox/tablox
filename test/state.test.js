/**
 * State calculation tests.
 *
 * The thresholds are the whole product, so the boundaries are asserted
 * individually and explicitly rather than swept. The colours are asserted as
 * literals too: `iconColor` is derived, and a derived value that is only checked
 * against itself would pass even if the derivation were wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STATES,
  getState,
  contrastRatio,
  bestTextOn,
  darkenToLuminance,
  relativeLuminance,
} from '../src/shared/state.js';
import { judgementPattern } from './helpers/copy.js';

/** Chrome's light and dark toolbar backgrounds. */
const LIGHT_TOOLBAR = '#FFFFFF';
const DARK_TOOLBAR = '#202124';

/** WCAG 1.4.11 minimum for a non-text graphic such as the icon shape. */
const GRAPHIC_MINIMUM = 3;

/** Every boundary in the specified table, plus one either side of each. */
const REQUIRED_BOUNDARIES = [3, 4, 6, 7, 9, 10, 12, 13];

test('required boundary counts map to the specified states', () => {
  const expected = {
    3: { id: 'focused', color: '#19DF96', label: 'Focused' },
    4: { id: 'growing', color: '#639CFF', label: 'Growing' },
    6: { id: 'growing', color: '#639CFF', label: 'Growing' },
    7: { id: 'crowded', color: '#FDCF06', label: 'Crowded' },
    9: { id: 'crowded', color: '#FDCF06', label: 'Crowded' },
    10: { id: 'fragmented', color: '#FF6F00', label: 'Fragmented' },
    12: { id: 'fragmented', color: '#FF6F00', label: 'Fragmented' },
    13: { id: 'overloaded', color: '#FF343A', label: 'Overloaded' },
  };

  for (const count of REQUIRED_BOUNDARIES) {
    const state = getState(count);
    assert.equal(state.id, expected[count].id, `${count} tabs → id`);
    assert.equal(state.label, expected[count].label, `${count} tabs → label`);
    assert.equal(state.color, expected[count].color, `${count} tabs → colour`);
  }
});

test('every count from 0 to 200 maps to the specified range', () => {
  for (let count = 0; count <= 200; count += 1) {
    const { id } = getState(count);
    const expected =
      count <= 3
        ? 'focused'
        : count <= 6
          ? 'growing'
          : count <= 9
            ? 'crowded'
            : count <= 12
              ? 'fragmented'
              : 'overloaded';
    assert.equal(id, expected, `${count} tabs → ${id}, expected ${expected}`);
  }
});

test('state boundaries are exactly where the specification says', () => {
  assert.deepEqual(
    STATES.map((state) => [state.minTabs, state.maxTabs]),
    [
      [1, 3],
      [4, 6],
      [7, 9],
      [10, 12],
      [13, null],
    ],
  );
});

test('the range labels match the thresholds they describe', () => {
  assert.deepEqual(STATES.map((state) => state.range), ['1–3', '4–6', '7–9', '10–12', '13+']);
});

test('counts below the first range clamp to the first state', () => {
  for (const count of [0, 1, 2, 3]) {
    assert.equal(getState(count).id, 'focused', `${count} tabs`);
  }
  assert.equal(getState(0).tabCount, 0, 'the badge still shows the true count');
});

test('the last state is open-ended', () => {
  for (const count of [13, 14, 50, 500, 10000]) {
    assert.equal(getState(count).id, 'overloaded', `${count} tabs`);
  }
  assert.equal(STATES.at(-1).maxTabs, null);
});

test('the boundary between each pair of states is single-count wide', () => {
  for (let i = 0; i < STATES.length - 1; i += 1) {
    const current = STATES[i];
    const next = STATES[i + 1];
    assert.equal(next.minTabs, current.maxTabs + 1, `${current.id} → ${next.id} gap`);
    assert.equal(getState(current.maxTabs).id, current.id);
    assert.equal(getState(next.minTabs).id, next.id);
  }
});

test('getState returns the full contract for every state', () => {
  for (const count of REQUIRED_BOUNDARIES) {
    const state = getState(count);
    for (const key of [
      'id',
      'label',
      'color',
      'iconColor',
      'badgeText',
      'range',
      'minTabs',
      'maxTabs',
      'explanation',
      'toast',
      'toastClose',
      'tabCount',
    ]) {
      assert.ok(key in state, `${count} tabs: missing "${key}"`);
    }
    assert.equal(state.tabCount, count);
    assert.match(state.color, /^#[0-9A-F]{6}$/, 'the badge has a colour to fill');
    assert.match(state.iconColor, /^#[0-9A-F]{6}$/, 'the shape has a colour to fill');
    assert.match(state.badgeText, /^#[0-9]{6}$/, 'the badge has a text colour');
  }
});

test('the state carries no icon paths — the icon is drawn at runtime', () => {
  for (const count of REQUIRED_BOUNDARIES) {
    const state = getState(count);
    for (const removed of ['iconPath', 'iconName', 'icon']) {
      assert.ok(!(removed in state), `${count} tabs: "${removed}" should be gone`);
    }
  }
});

test('no state references an icon file', () => {
  const source = readFileSync(new URL('../src/shared/state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.png/, 'state.js must not name any icon file');
});

test('the five badge colours are exactly the ones specified', () => {
  assert.deepEqual(
    STATES.map((state) => state.color),
    ['#19DF96', '#639CFF', '#FDCF06', '#FF6F00', '#FF343A'],
  );
});

test('the icon colours are the specified hues, darkened to one target', () => {
  // Stated as literals, not recomputed from CORNER_RATIO or the derivation: a
  // test that agreed with the implementation would pass even if the darkening
  // maths were wrong.
  assert.deepEqual(
    STATES.map((state) => state.iconColor),
    ['#109162', '#2D79FF', '#997D01', '#D25C00', '#FF0911'],
  );
});

test('the icon colour is visibly darker than the badge colour it came from', () => {
  for (const state of STATES) {
    assert.ok(
      relativeLuminance(state.iconColor) < relativeLuminance(state.color),
      `${state.id}: ${state.iconColor} is not darker than ${state.color}`,
    );
  }
});

test('the icon shape is legible on both Chrome toolbars', () => {
  // This is the whole reason iconColor exists: the specified hues clear 3:1 on
  // a dark toolbar and four of the five fail badly on a light one.
  for (const state of STATES) {
    for (const [label, background] of [
      ['light', LIGHT_TOOLBAR],
      ['dark', DARK_TOOLBAR],
    ]) {
      const ratio = contrastRatio(state.iconColor, background);
      assert.ok(
        ratio >= GRAPHIC_MINIMUM,
        `${state.id} on a ${label} toolbar: ${ratio.toFixed(2)}:1, need ${GRAPHIC_MINIMUM}:1`,
      );
    }
  }
});

test('the badge is legible in every state', () => {
  // Chrome draws the badge text in badgeText over the bright colour, and the
  // default white would be close to invisible on the yellow and green.
  for (const state of STATES) {
    const ratio = contrastRatio(state.color, state.badgeText);
    assert.ok(
      ratio >= 4.5,
      `${state.id}: badge text ${state.badgeText} on ${state.color} is only ${ratio.toFixed(2)}:1`,
    );
    assert.equal(state.badgeText, bestTextOn(state.color), `${state.id} badge text is not the best choice`);
  }
});

test('the specified hues really would fail on a light toolbar, or the split is pointless', () => {
  // Guards the reason for the two-colour design. If this ever stops holding, the
  // extra iconColor column is no longer earning its place.
  const failing = STATES.filter(
    (state) => contrastRatio(state.color, LIGHT_TOOLBAR) < GRAPHIC_MINIMUM,
  );
  assert.equal(failing.length, 4, 'expected four of the five badge hues to fail on white');
});

test('bestTextOn picks whichever of black and white actually wins', () => {
  for (const background of ['#000000', '#FFFFFF', '#19DF96', '#FDCF06', '#639CFF']) {
    const picked = bestTextOn(background);
    const other = picked === '#000000' ? '#FFFFFF' : '#000000';
    assert.ok(
      contrastRatio(background, picked) >= contrastRatio(background, other),
      `${background}: ${picked} is not the better of the two`,
    );
  }
});

test('darkenToLuminance hits its target and keeps hue and saturation', () => {
  for (const state of STATES) {
    const luminance = relativeLuminance(state.iconColor);
    assert.ok(
      Math.abs(luminance - 0.215) < 0.005,
      `${state.id}: luminance ${luminance.toFixed(4)} is not the 0.215 target`,
    );
  }

  // Same hue, so the darkened colours are recognisably the specified ones.
  assert.equal(darkenToLuminance('#19DF96', 0.215), '#109162');
  assert.equal(darkenToLuminance('#FDCF06', 0.215), '#997D01');
});

test('explanations are the specified copy, word for word', () => {
  assert.deepEqual(
    STATES.map((state) => state.explanation),
    [
      'Your browser context is light, with little to keep track of.',
      'More information is building up in your browser context.',
      'More information is making it harder to quickly find what you need.',
      'Different pages and tasks are competing for your attention.',
      'There is a lot to organize, find, and return to.',
    ],
  );
});

test('labels are exactly the five specified states', () => {
  assert.deepEqual(
    STATES.map((state) => state.label),
    ['Focused', 'Growing', 'Crowded', 'Fragmented', 'Overloaded'],
  );
});

test('no copy scores, shames, or nags', () => {
  // Tablox signals; it must not assert a cognitive limit or scold the user. The
  // specified copy deliberately says tab count alone cannot measure load, so the
  // loaded cognitive terms are only allowed where the copy disclaims them.
  const banned = [
    'working memory',
    'attention span',
    'attention limit',
    'you should',
    'focus harder',
    'productivity',
    'score',
    'streak',
    'danger',
    'critical',
    'excessive',
    'close tabs',
  ];

  for (const state of STATES) {
    const copy = `${state.label} ${state.explanation}`.toLowerCase();
    for (const phrase of banned) {
      assert.ok(!copy.includes(phrase), `"${phrase}" found in ${state.id} copy`);
    }
  }
});

test('the copy describes the tab count, not a verdict on the user', () => {
  // Second person is the intended voice — the copy is written *to* someone, and
  // banning "your" would only push it towards a colder, more clinical register.
  // What is banned is telling someone what their tab count says about them.
  const judgement = judgementPattern();

  for (const state of STATES) {
    assert.ok(state.explanation.endsWith('.'), `${state.id} explanation is not a sentence`);
    assert.doesNotMatch(state.explanation, judgement, `${state.id} copy judges the user`);
  }
});

test('the copy is allowed to talk about the browser, not the person', () => {
  // A counter-test for the guard above: the vocabulary it permits has to be
  // genuinely in use, or the guard is passing because the copy went mute.
  const mentions = STATES.filter((state) => /\byour\b/i.test(state.explanation));
  assert.ok(mentions.length >= 3, 'second person is still part of the voice');
});

test('invalid input is coerced rather than throwing', () => {
  for (const input of [undefined, null, NaN, -5, 3.7, '4', Infinity, -Infinity]) {
    const state = getState(input);
    assert.equal(typeof state.tabCount, 'number');
    assert.ok(Number.isInteger(state.tabCount), `${String(input)} → ${state.tabCount}`);
    assert.ok(STATES.some((candidate) => candidate.id === state.id));
  }
  assert.equal(getState(3.7).tabCount, 3, 'fractional counts floor');
  assert.equal(getState(-5).tabCount, 0, 'negative counts clamp to zero');
  assert.equal(getState(undefined).id, 'focused');
});

test('getState is pure — repeated calls do not mutate prior results', () => {
  const first = getState(7);
  const snapshot = { ...first };
  getState(99);
  getState(1);
  assert.deepEqual({ ...first }, snapshot);
  assert.throws(() => {
    'use strict';
    first.label = 'mutated';
  }, TypeError, 'returned state is frozen');
});

test('the state table is frozen against accidental threshold edits', () => {
  assert.throws(() => {
    'use strict';
    STATES[0].maxTabs = 99;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    STATES.push({});
  }, TypeError);
});

test('state ids are unique and well-formed', () => {
  const ids = STATES.map((state) => state.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate state id');
  for (const id of ids) assert.match(id, /^[a-z]+$/, id);
});
