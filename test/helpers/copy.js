/**
 * Copy policy shared by the popup and the toast.
 *
 * Tablox talks about tab counts, not about people. The line between those two
 * is not "does it say you" — second person is the intended voice, and the copy
 * would be colder without it. The line is "does it tell someone what their tab
 * count means about them".
 *
 * Keeping the vocabulary in one place matters: the popup and the toast are
 * written by different people at different times, and a word allowed in one and
 * banned in the other would only be a question of which file a reviewer opened
 * first.
 *
 * Entries are stems wherever a word has a family. `wast\\w*` covers wasteful,
 * wasting and waste in one entry, so deleting one of those words cannot quietly
 * open a hole for the others — a gap this list cannot afford, since a
 * vocabulary that is only as good as its most recently remembered word is not a
 * guard at all.
 */

/**
 * Words that turn an observation about tabs into a judgement about a person.
 *
 * Grouped by why they are here, so a future word can be added next to its kin
 * rather than to whatever happened to be alphabetically adjacent.
 */
export const JUDGEMENT_WORDS = [
  // Sloth and effort.
  'lazy',
  'laziness',
  'slack',
  'procrastinat\\w*',
  // Waste as a moral failing.
  'wast\\w*',
  'squander\\w*',
  // Discipline and self-management.
  'disciplin\\w*',
  'self-control',
  // Clinical language, which is a verdict wearing a lab coat.
  'addict\\w*',
  'compulsive',
  'patholog\\w*',
  'deficien\\w*',
  'dysfunction\\w*',
];

/** A matcher for judgement vocabulary, in word-boundary form. */
export const judgementPattern = () => new RegExp(`\\b(${JUDGEMENT_WORDS.join('|')})\\b`, 'i');
