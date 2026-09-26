/**
 * Tablox in-page toast.
 *
 * Draws the one-line state quip over the top of the page, briefly, whenever
 * Tablox enters a new state.
 *
 * This file is deliberately dumb. It holds no thresholds, no colours and no
 * copy of its own: the service worker sends a finished message with the text and
 * the two colours already resolved from `shared/state.js`, and this only paints
 * it. That keeps one writer for the state — as with the toolbar — and means the
 * page context never gets to decide what Tablox thinks.
 *
 * It also means this file cannot be trusted with anything sensitive. It receives
 * a string and two colours and puts them on screen. It does not read the page,
 * and the only DOM it touches is the single element it creates itself.
 *
 * Styling is scoped with a shadow root because this runs inside pages we do not
 * control: a page's own CSS must not be able to restyle the toast, and ours must
 * not leak into the page. Inherited properties (font, colour, line-height) do
 * cross the shadow boundary, so those are set explicitly on the toast itself.
 *
 * Runs at `document_idle` in the top frame only. Nothing here is interactive —
 * the host is `pointer-events: none`, so the toast can never intercept a click
 * or a keystroke, no matter what is underneath it.
 */

(() => {
  const HOST_ID = 'tablox-toast-host';
  const HOST_Z_INDEX = '2147483647';

  /**
   * Enter/exit timings, and how long the toast stays put between them.
   *
   * 340 + 2400 + 260 is three seconds end to end, which is the specified
   * "approximately 2-3 seconds" measured the way a person experiences it — from
   * the first pixel arriving to the last one leaving.
   */
  const ENTER_MS = 340;
  const EXIT_MS = 260;
  const HOLD_MS = 2400;

  /** How transparent the pill is. Low enough to read as solid, not as glass. */
  const BACKGROUND_ALPHA = 0.94;

  const EASE_ENTER = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const EASE_EXIT = 'cubic-bezier(0.7, 0, 0.84, 0)';

  /** The toast currently on screen, if any. */
  let showing = null;

  const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const CSS = `
    :host { all: initial; }

    .row {
      display: flex;
      justify-content: center;
      padding: 14px 16px 0;
    }

    .toast {
      box-sizing: border-box;
      max-width: min(560px, calc(100vw - 32px));
      padding: 11px 20px;
      border-radius: 999px;

      /* Inherited from the page, so set explicitly rather than left to chance. */
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      font-size: 14px;
      font-weight: 500;
      font-style: normal;
      line-height: 1.35;
      letter-spacing: normal;
      text-align: center;
      text-transform: none;
      white-space: normal;
      overflow-wrap: anywhere;

      color: var(--tablox-toast-text);
      background-color: var(--tablox-toast-bg);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28), 0 1px 2px rgba(0, 0, 0, 0.2);

      /* A little transparency, as specified, plus a touch of blur so text
         underneath does not fight the label for legibility. */
      -webkit-backdrop-filter: blur(8px) saturate(1.3);
      backdrop-filter: blur(8px) saturate(1.3);

      will-change: transform, opacity;
    }

    @media (prefers-reduced-motion: reduce) {
      .toast { will-change: auto; }
    }
  `;

  /**
   * Remove whatever is currently on screen, immediately.
   *
   * @returns {Promise<void>} resolves once the old toast is gone
   */
  async function clear() {
    if (!showing) return;
    const current = showing;
    showing = null;
    current.cancelled = true;
    clearTimeout(current.holdTimer);
    try {
      current.exit?.cancel();
    } catch {
      /* the animation may already be finished; nothing to undo */
    }
    current.host.remove();
  }

  /**
   * Show a toast, replacing any already on screen.
   *
   * @param {{ text: string, color: string, textColor: string }} message
   * @returns {Promise<void>} resolves once this toast has animated out
   */
  async function show({ text, color, textColor }) {
    if (typeof text !== 'string' || text === '') return;

    // Replacing rather than queueing: a state change that arrives mid-toast is
    // new information, and the user is better served by the latest line than by
    // a queue of stale ones.
    await clear();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    // Inline so page CSS cannot reposition it, and inert so it cannot eat a click.
    host.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      `z-index:${HOST_Z_INDEX}`,
      'pointer-events:none',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const row = document.createElement('div');
    row.className = 'row';

    const toast = document.createElement('div');
    toast.className = 'toast';
    // textContent, never innerHTML: the string comes from our own state table,
    // but a page should not be able to talk us into parsing markup.
    toast.textContent = text;
    toast.style.setProperty('--tablox-toast-bg', withAlpha(color, BACKGROUND_ALPHA));
    toast.style.setProperty('--tablox-toast-text', textColor);

    row.append(toast);
    shadow.append(style, row);
    (document.body ?? document.documentElement).append(host);

    const current = { host, toast, holdTimer: null, exit: null, cancelled: false };
    showing = current;

    const duration = (ms) => (prefersReducedMotion() ? 0 : ms);

    const enter = toast.animate(
      [
        { transform: 'translateY(-160%)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration: duration(ENTER_MS), easing: EASE_ENTER, fill: 'both' },
    );

    try {
      // Raced against a timer rather than simply awaited. An animation is driven
      // by the page's timeline, and a page that is not being rendered stops
      // advancing it — so on a background tab `finished` can settle never, and
      // everything sequenced after it would never run. A timer keeps running
      // when a page is hidden. The animation is how the toast looks; the timer
      // is what decides when it has finished looking.
      await Promise.race([enter.finished, wait(duration(ENTER_MS))]);
    } catch {
      /* cancelled by a newer toast; that one takes over from here */
    }
    if (current.cancelled) return;

    await wait(HOLD_MS);
    if (current.cancelled) return;

    const exit = toast.animate(
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: 'translateY(-160%)', opacity: 0 },
      ],
      { duration: duration(EXIT_MS), easing: EASE_EXIT, fill: 'both' },
    );
    current.exit = exit;

    try {
      await Promise.race([exit.finished, wait(duration(EXIT_MS))]);
    } catch {
      /* cancelled again; clear() has already removed the host */
    }
    if (current.cancelled) return;

    showing = null;
    host.remove();
  }

  /**
   * Apply an alpha to a `#RRGGBB` colour.
   *
   * @param {string} hex
   * @param {number} alpha 0-1
   * @returns {string} an `rgba()` string
   */
  function withAlpha(hex, alpha) {
    const value = Number.parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(value)) return hex;
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'tablox:toast') return undefined;
    show(message);
    // Nothing is sent back: the toast is fire-and-forget, and returning true
    // here would keep a message channel open for no reason.
    return undefined;
  });

  // Say that this tab is listening.
  //
  // A tab that opened a threshold does not exist yet when the worker decides to
  // announce it, and this script has not run when the message first goes out. So
  // the tab announces itself instead, and the worker hands over the crossing it
  // missed. Without this the toast either waits to be polled for — arriving
  // seconds after the event, on the page you are looking at — or never arrives.
  //
  // Carries nothing: no URL, no title, no page state. The worker already knows
  // which tab id this is, because Chrome sends it along.
  try {
    const announced = chrome.runtime.sendMessage({ type: 'tablox:ready' });
    if (announced && typeof announced.catch === 'function') announced.catch(() => {});
  } catch {
    /* the worker may be restarting; the next load will try again */
  }
})();
