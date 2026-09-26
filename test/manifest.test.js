/**
 * Manifest and privacy tests.
 *
 * These are the structural guarantees: the extension asks for nothing it does
 * not need, loads no remote code, talks to no network, and keeps every
 * threshold in one place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '../scripts/validate-manifest.mjs';
import { stripComments } from './helpers/source.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** Every JS and JSON file under src/, as { path, source }. */
function sourceFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|json|html|css)$/.test(entry)) {
      const source = readFileSync(full, 'utf8');
      out.push({
        path: full,
        name: relative(ROOT, full),
        source,
        // For tests that scan for a forbidden token: a comment explaining why a
        // thing is avoided must not count as using it.
        code: full.endsWith('.js') ? stripComments(source) : source,
      });
    }
  }
  return out;
}

const FILES = sourceFiles();
const JS_FILES = FILES.filter((file) => file.name.endsWith('.js'));

test('the manifest passes every specification check', () => {
  const { problems } = validateManifest();
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('requests the tabs permission and nothing else', () => {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['tabs']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  // `content_scripts` is not a permission and is covered on its own below.
});

test('requires Chrome 110, the version that added setBadgeTextColor', () => {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  // The worker calls chrome.action.setBadgeTextColor unconditionally. On an
  // older Chrome that call throws and the badge falls back to Chrome's white
  // default, which is 1.75:1 on the yellow badge — an invisible badge in four of
  // the five states. Declaring the floor makes such a browser refuse to install
  // the extension, which is better than installing one that cannot be read.
  assert.equal(manifest.minimum_chrome_version, '110');
});

test('the version floor and the unconditional badge-text-colour call agree', () => {
  // Guards the pairing: either half alone is not enough. A future edit that
  // guards the call with `if (chrome.action.setBadgeTextColor)` would keep the
  // manifest valid while reintroducing the silent degradation above, and a
  // future edit that lowers the floor would leave older browsers unprotected.
  const worker = readFileSync(join(SRC, 'background', 'service-worker.js'), 'utf8');
  const calls = worker
    .split('\n')
    .filter((line) => line.includes('chrome.action.setBadgeTextColor'));

  // One line, and that line is nothing but the call. Any guard shape — an
  // `if`, an `&&`, optional chaining, a multi-line `if` on the line above —
  // either mentions the API twice or puts something before it on the line, so
  // both count and shape are asserted. Matching only against `/if\s*\(/` would
  // miss every one of those but the first.
  assert.equal(calls.length, 1, 'the badge text colour must be set in exactly one place');
  assert.match(
    calls[0],
    /^\s*chrome\.action\.setBadgeTextColor\(\{[^}]*\}\),?\s*$/,
    'the call must be unconditional: the manifest version floor is the only guard',
  );
});

test('the only content script is the toast, and it is declared once', () => {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts ?? [];

  assert.equal(scripts.length, 1, `expected one content script, got ${scripts.length}`);
  assert.deepEqual(scripts[0].js, ['content/toast.js']);
  assert.deepEqual(scripts[0].matches, ['<all_urls>']);
  assert.equal(scripts[0].css, undefined, 'the toast injects no CSS into pages');
  assert.equal(scripts[0].all_frames, false, 'top frame only');
  assert.equal(scripts[0].run_at, 'document_idle');

  // Nothing may inject code at runtime, which would sidestep the declaration
  // above and make the permission surface unknowable by reading the manifest.
  for (const file of FILES) {
    assert.ok(
      !/executeScript|registerContentScripts|insertCSS|getCSS/.test(file.code),
      `${file.name} can inject code at runtime`,
    );
  }
});

test('the toast reads nothing from the page it is drawn on', () => {
  // The toast runs in every page, so this is the one file where "reads no page
  // content" has to be earned rather than assumed: it may create elements and
  // append them, and it may do nothing else. Anything on this list would be the
  // extension reaching into a page it was only invited to draw on.
  const toast = JS_FILES.find((file) => file.name.endsWith('content/toast.js'));
  assert.ok(toast, 'the toast content script exists');

  for (const forbidden of [
    '.innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'querySelector',
    'getElementsBy',
    'localStorage',
    'sessionStorage',
    'document.cookie',
    'indexedDB',
    'XMLHttpRequest',
    'fetch(',
    'WebSocket',
    'postMessage',
    'navigator.',
    'location.',
    'window.name',
  ]) {
    assert.ok(!toast.code.includes(forbidden), `the toast references ${forbidden}`);
  }

  // Writing the toast's own text is the one safe way to put a string on screen
  // without parsing it as markup, and `.textContent` is the same token for
  // reading and writing — so assignments are removed before checking that
  // nothing is ever read back.
  assert.match(toast.code, /\.textContent\s*=/, 'the toast must set its text via textContent');
  const reads = toast.code.replace(/\.textContent\s*=[^;]*/g, '');
  assert.ok(!reads.includes('.textContent'), 'the toast reads text back out of the page');
});

test('the toast never waits on an animation to be rid of it', () => {
  // An animation's `finished` promise is driven by the page's timeline, and a
  // page that is not being rendered stops advancing that timeline. A toast that
  // waits on one to sequence its own removal is therefore never removed on a tab
  // the user has moved away from — it stays in the DOM, held by a timeline that
  // has stopped. That is not hypothetical: it is what real Chrome was observed
  // doing, with the exit animation reported as still "running" at zero progress
  // long after the toast should have gone.
  //
  // Timers keep firing when a page is hidden; animation timelines do not. So the
  // toast may use an animation to look right, and must never depend on one to
  // know when it is finished.
  const toast = JS_FILES.find((file) => file.name.endsWith('content/toast.js'));
  assert.ok(toast, 'the toast content script exists');

  const awaited = [...toast.code.matchAll(/await\s+[\w.]+\.finished\s*;/g)];
  assert.deepEqual(
    awaited.map((match) => match[0]),
    [],
    'the toast awaits an animation promise directly, so a hidden page would keep it forever',
  );
  assert.match(
    toast.code,
    /Promise\.race\(\[enter\.finished/,
    'the enter animation is not raced against a timer',
  );
  assert.match(
    toast.code,
    /Promise\.race\(\[exit\.finished/,
    'the exit animation is not raced against a timer',
  );
});

test('thresholds are declared in exactly one file', () => {
  const stateModule = join(SRC, 'shared', 'state.js');

  for (const file of JS_FILES) {
    if (file.path === stateModule) continue;

    // A duplicated threshold would look like a comparison against a boundary.
    const comparison = /(<=|>=|<|>)\s*(3|6|7|11|12)\b/.exec(file.source);
    assert.equal(
      comparison,
      null,
      `${file.name} compares against ${comparison?.[2]} — thresholds belong in shared/state.js`,
    );
  }
});

test('the popup and the service worker both consume the shared state module', () => {
  for (const name of ['src/popup/popup.js', 'src/background/service-worker.js']) {
    const file = FILES.find((candidate) => candidate.name === name);
    assert.ok(file, `${name} exists`);
    assert.match(
      file.source,
      /import\s*\{[^}]*getState[^}]*\}\s*from\s*'[^']*shared\/state\.js'/,
      `${name} imports getState from shared/state.js`,
    );
  }
});

test('no source file makes a network request', () => {
  const banned = [
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'navigator.sendBeacon',
    'importScripts',
    'chrome.downloads',
  ];

  for (const file of FILES) {
    for (const needle of banned) {
      assert.ok(!file.code.includes(needle), `${file.name} uses ${needle}`);
    }
  }
});

test('loads no remote or dynamically generated code', () => {
  for (const file of FILES) {
    for (const needle of ['eval(', 'new Function', 'import(', 'require(', 'innerHTML']) {
      if (file.name === 'src/background/service-worker.js' && needle === 'import(') continue;
      assert.ok(!file.code.includes(needle), `${file.name} uses ${needle}`);
    }
  }

  const html = readFileSync(join(SRC, 'popup', 'popup.html'), 'utf8');
  assert.ok(!/<script[^>]*>[^<]/.test(html), 'popup has no inline script');
  assert.ok(!/src\s*=\s*["']https?:/.test(html), 'popup loads no remote script');
  assert.ok(!/<link[^>]*href\s*=\s*["']https?:/.test(html), 'popup loads no remote stylesheet');
});

test('declares no storage, so nothing is persisted or synced', () => {
  for (const file of FILES) {
    for (const needle of [
      'chrome.storage',
      'chrome.sync',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
    ]) {
      assert.ok(!file.code.includes(needle), `${file.name} uses ${needle}`);
    }
  }
});

test('reads no page content: no URL, title, favicon, or DOM access', () => {
  for (const file of FILES) {
    for (const needle of ['.url', '.title', 'favIconUrl', 'getSelection', 'querySelector']) {
      assert.ok(!file.code.includes(needle), `${file.name} references ${needle}`);
    }
  }
});

test('every tab query asks for nothing a page owns', () => {
  const worker = FILES.find((file) => file.name === 'src/background/service-worker.js');
  const queries = [...worker.source.matchAll(/chrome\.tabs\.query\(([^)]*)\)/g)];

  assert.ok(queries.length > 0, 'the worker queries tabs');

  // Two forms are allowed, and only two: the bare count query, and the
  // foreground-tab filter the toast needs. Both return bare tab records, so
  // neither can reach a URL, a title, or a favicon. Anything carrying a key
  // that selects or returns page data is refused here.
  const ALLOWED = [/^\{\}$/, /^\{\s*active:\s*true\s*\}$/];

  for (const [, args] of queries) {
    const trimmed = args.trim();
    assert.ok(
      ALLOWED.some((pattern) => pattern.test(trimmed)),
      `tabs.query called with ${trimmed}, which is neither the bare count nor the active-tab filter`,
    );
  }
});

test('polls nothing — no timers or alarms anywhere', () => {
  for (const file of JS_FILES) {
    for (const needle of ['setInterval', 'chrome.alarms', 'requestAnimationFrame']) {
      assert.ok(!file.code.includes(needle), `${file.name} uses ${needle}`);
    }
  }
});

test('the project has no runtime or dev dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.devDependencies, undefined, 'no dev dependencies');
});
