/**
 * Helpers for tests that read extension source as text.
 *
 * Several guardrail tests work by scanning source for a forbidden token. Doing
 * that on raw text means a *comment* naming the forbidden thing fails the build,
 * which is how `toast.js` came to fail a check for using `innerHTML` after
 * explaining in a comment why it uses `textContent` instead. Stripping comments
 * first keeps those tests aimed at code.
 */

import { readFileSync } from 'node:fs';

/**
 * Strip comments from JavaScript source, leaving code and string literals alone
 * as far as a regular expression can manage.
 *
 * Good enough for token scans, which is all these are used for. It is not a
 * parser and does not try to be: block comments, then line comments, then the
 * contents of single- and double-quoted strings, then template literals.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Read a source file with its comments removed.
 *
 * @param {string} path
 * @returns {string}
 */
export function readCode(path) {
  return stripComments(readFileSync(path, 'utf8'));
}
