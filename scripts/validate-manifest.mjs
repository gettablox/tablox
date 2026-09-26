/**
 * Validates src/manifest.json against the specification and against the files
 * actually on disk. Exits non-zero on failure so it can gate a build.
 *
 * Run with `npm run verify:manifest`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const problems = [];
const checks = [];

function check(label, condition, detail) {
  checks.push(label);
  if (!condition) problems.push(detail ? `${label} — ${detail}` : label);
}

export function validateManifest() {
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));

  check('manifest_version is 3', manifest.manifest_version === 3, `got ${manifest.manifest_version}`);
  check('has a name', typeof manifest.name === 'string' && manifest.name.length > 0);
  check('has a version', /^\d+(\.\d+){0,3}$/.test(manifest.version ?? ''), `got ${manifest.version}`);
  check('has a description', typeof manifest.description === 'string');

  // The worker calls chrome.action.setBadgeTextColor without a runtime guard, so
  // the manifest has to refuse installation on anything that lacks it rather
  // than leaving a bright badge with unreadable default white text.
  const minimumChrome = Number.parseInt(manifest.minimum_chrome_version ?? '', 10);
  check(
    'requires a Chrome new enough for setBadgeTextColor',
    Number.isInteger(minimumChrome) && minimumChrome >= 110,
    `got ${JSON.stringify(manifest.minimum_chrome_version)}, need 110 or later`,
  );

  // Permissions: exactly ["tabs"] and nothing else.
  const permissions = manifest.permissions ?? [];
  check(
    'requests only the tabs permission',
    permissions.length === 1 && permissions[0] === 'tabs',
    `got ${JSON.stringify(permissions)}`,
  );

  for (const forbidden of [
    'host_permissions',
    'optional_permissions',
    'optional_host_permissions',
    'web_accessible_resources',
    'declarative_net_request',
    'externally_connectable',
    'content_security_policy',
  ]) {
    check(`declares no ${forbidden}`, manifest[forbidden] === undefined);
  }

  // Content scripts. The toast is drawn in the page, so one is unavoidable now,
  // and that is a real widening of what the extension can reach. It is held to
  // an exact shape rather than merely allowed: one script, our own file, every
  // URL, top frame only, no CSS and no web-accessible resources. Anything looser
  // than this has to be a deliberate edit here, not a side effect of a change
  // to the toast.
  const scripts = manifest.content_scripts ?? [];
  check('declares exactly one content script', scripts.length === 1, `got ${scripts.length}`);
  const [script] = scripts;
  check(
    'the content script matches all URLs',
    Array.isArray(script?.matches) && script.matches.length === 1 && script.matches[0] === '<all_urls>',
    `got ${JSON.stringify(script?.matches)}`,
  );
  check(
    'the content script is our own toast, and nothing else',
    Array.isArray(script?.js) && script.js.length === 1 && script.js[0] === 'content/toast.js',
    `got ${JSON.stringify(script?.js)}`,
  );
  check('the content script injects no CSS', script?.css === undefined);
  check('the content script runs in the top frame only', script?.all_frames === false);
  check('the content script waits for the page to be idle', script?.run_at === 'document_idle');
  check(
    'content script file exists',
    typeof script?.js?.[0] === 'string' && existsSync(join(SRC, script.js[0])),
  );

  // Service worker.
  const worker = manifest.background?.service_worker;
  check('declares a background service worker', typeof worker === 'string');
  check('service worker is an ES module', manifest.background?.type === 'module');
  check('service worker file exists', typeof worker === 'string' && existsSync(join(SRC, worker)));

  // Action / popup.
  const popup = manifest.action?.default_popup;
  check('action declares a default popup', typeof popup === 'string');
  check('popup file exists', typeof popup === 'string' && existsSync(join(SRC, popup)));
  check('does not use the deprecated browser_action', manifest.browser_action === undefined);

  // Icons: every referenced path must exist.
  for (const [label, icons] of [
    ['action.default_icon', manifest.action?.default_icon],
    ['icons', manifest.icons],
  ]) {
    if (!icons) continue;
    for (const [size, path] of Object.entries(icons)) {
      check(`${label}[${size}] exists`, existsSync(join(SRC, path)), path);
    }
  }

  return { manifest, problems, checks };
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const { problems, checks } = validateManifest();
  for (const label of checks) problems.includes(label) || console.log(`  ok  ${label}`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} manifest problem(s):`);
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    process.exit(1);
  }
  console.log(`\nmanifest valid — ${checks.length} checks passed`);
}
