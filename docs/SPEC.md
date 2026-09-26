# Tablox — Specification

**Version:** 0.1.0
**Status:** Approved for implementation
**Last updated:** 2026-09-26

This document is the source of truth for Tablox V0.1. Code must match this document. If they
disagree, the document is wrong and gets updated first.

---

## 1. Product

Tablox is a minimal browser signal showing how much browser context is currently open.

The product hypothesis is:

> Keeping fewer simultaneously available tabs may reduce opportunities for task switching and help
> the user stay with the current information.

This is a behavioral experiment, not a claim about cognition. Tablox does **not** assert that any
particular number of tabs causes cognitive overload, exceeds working memory, or represents a
scientifically established attention limit. There is no such claim anywhere in the product, its
copy, or its code.

Tablox **signals**. It never polices. It never shames, blocks, closes, or manages tabs
automatically. The user may ignore it entirely and nothing happens.

### Non-goals (V0.1)

Explicitly out of scope. Not deferred features — excluded by design:

- Tab history or any record of past counts
- Analytics dashboards
- Behavioral scoring, scores, streaks, achievements, gamification
- AI of any kind
- Recommendations or tab suggestions
- Automatic tab closing, automatic bookmarking, tab grouping
- Notifications, sounds
- Accounts, cloud storage, synchronization

---

## 2. State system

Tablox counts all currently open browser tabs across all windows, then maps that count to exactly
one of five states.

|  Tabs | State      | Badge colour | Icon colour | Toast                                        |
| ----: | ---------- | ------------ | ----------- | -------------------------------------------- |
|   1–3 | Focused    | `#19DF96`    | `#109162`   | Clean slate. Enjoy it                        |
|   4–6 | Growing    | `#639CFF`    | `#2D79FF`   | The hoarding has begun                       |
|   7–9 | Crowded    | `#FDCF06`    | `#997D01`   | Tab archaeology begins                       |
| 10–12 | Fragmented | `#FF6F00`    | `#D25C00`   | Which one was I looking for again?           |
|   13+ | Overloaded | `#FF343A`    | `#FF0911`   | This is no longer a browser. It’s a database |

The copy is the same in the toast and the popup, and lives in this one table.
A state is a colour, a range, an explanation and a toast — never two of those
things in two places.

### Required boundary behaviour

```text
 3  → #19DF96 / Focused
 4  → #639CFF / Growing
 6  → #639CFF / Growing
 7  → #FDCF06 / Crowded
 9  → #FDCF06 / Crowded
10  → #FF6F00 / Fragmented
12  → #FF6F00 / Fragmented
13  → #FF343A / Overloaded
```

The upper bound of the last state is open-ended.

### Why each state has two colours

The badge colour and the icon colour are the same hue at two different lightnesses, and the
difference is forced by the surfaces they sit on.

- The **badge** is a self-contained pill: its own background, its own near-black text, no
  competition. That is exactly where a bright saturated colour is strongest, so the badge uses the
  specified bright hue.
- The **icon** sits directly on the Chrome toolbar, whose background Tablox does not control and
  which follows the OS light/dark theme. WCAG 1.4.11 asks 3:1 for a non-text graphic. The five
  bright hues reach 3:1 on a dark toolbar but four of the five fail on a light one — the yellow at
  1.49:1 and the green at 1.74:1 are close to invisible.

`iconColor` is therefore **derived** from `color`, not hand-written: the same hue and saturation at
a lightness solved for a relative luminance of 0.215, which lands every state at about 4:1 against
both a white and a dark toolbar. Deriving it means editing a hue in `STATES` cannot silently break
the contrast guarantee. Working in HSL rather than scaling RGB channels is what keeps a darkened
orange orange instead of brown.

### Centralization requirement

All threshold logic lives in exactly one function, `getState(tabCount)`, in
`src/shared/state.js`. The popup and the background service worker both consume it. Neither may
re-implement, restate, or duplicate a threshold. A threshold is changed by editing the single
`STATES` array.

### `getState` contract

```js
getState(tabCount) -> {
  id:          'focused' | 'growing' | 'crowded' | 'fragmented' | 'overloaded',
  label:       'Focused' | 'Growing' | 'Crowded' | 'Fragmented' | 'Overloaded',
  color:       '#RRGGBB',   // the badge background
  iconColor:   '#RRGGBB',   // the shape fill, derived from `color`
  badgeText:   '#RRGGBB',   // badge label colour, derived from `color`
  range:       string,       // human-readable range, e.g. '1–3'
  minTabs:     number,       // inclusive lower bound
  maxTabs:     number|null,  // inclusive upper bound, null = open-ended
  explanation: string,       // one or two sentences
  tabCount:    number        // echoed back for convenience
}
```

`getState` is pure: same input, same output, no side effects, no I/O. It returns no icon
paths: the icon is drawn at runtime from `iconColor`.

### Edge case: 0 tabs

Zero tabs (every window closed) is outside the table above. **Decision:** clamp to `focused`. The
badge reads `0`. Rationale: zero open tabs is unambiguously a small context, and clamping keeps
`getState` total over `count >= 0` with no special case in any consumer.

The badge is set to the literal string `"0"`, not to an empty string. A blank badge and a badge
reading zero are easy to confuse at a glance, and Chrome will happily hide a badge whose text is
empty.

---

## 3. Toolbar icon

The toolbar icon is a **square with a 2px corner radius**, filled with the state's `iconColor`. It
carries no text.

```text
1–3   → #109162 square
4–6   → #2D79FF square
7–9   → #997D01 square
10–12 → #D25C00 square
13+   → #FF0911 square
```

### Geometry

| Property        | Value                                             |
| --------------- | ------------------------------------------------- |
| Canvas          | 32×32 at runtime                                  |
| Shape           | square, all four corners rounded                  |
| Corner radius   | 2px on the 32px icon (`CORNER_RATIO` = 2/32)      |
| Edge margin     | 1px transparent on every side (`EDGE_INSET`)      |
| Canvas coverage | 87.9% of 32×32                                    |

**The radius is 2px, not a shape-defining radius.** The brief asked for a square with rounded
corners, and 2px is enough to soften an aliased corner point without turning the form into a
squircle. The two square-derived proportions — the box and the fill — are what keep it reading as
a square at 16px.

**The 1px margin is what "maximum area" means here.** The brief asked for maximum area, and the
shape uses the whole canvas except this one-pixel ring. The margin is kept for a specific reason:
at 32px a shape that bleeds to the very edge has its anti-aliased corner pixels clipped by Chrome's
own resampling, which shows as a faint dark fringe on a light toolbar. One pixel of transparency
moves the edge off the clip boundary while still covering 90% of the canvas, so nothing visible is
lost.

**The radius is held as a ratio, not a pixel count,** so the static 16/48/128px manifest icons keep
the same visual weight instead of looking razor-sharp at 16px and bloated at 128px.

### One size at runtime, not four

Chrome accepts a single `imageData` for `chrome.action.setIcon` and rejects an array of them
outright — passing an array fails with *"Invalid type: expected
[extensionTypes.ImageDataType|object], found array"*. There is therefore no way to supply a
native-resolution image per size and let Chrome pick; Chrome resamples the one image it is given.

32 is the best single compromise: it is the native action-icon size on high-DPI displays and a
clean 2× reduction on standard ones. The only surface that looks soft is the 128px thumbnail on the
extensions page, which is rarely looked at, and the toolbar — the whole point of the product — is
always sharp.

The shape renderer is nonetheless correct at any size, and the four static manifest icons are
generated from it.

### Why the icon carries no number

The count is Chrome's badge, not the icon. See §4. This is a constraint on the icon, not a
preference: an icon that also drew digits would show the number twice, in two typefaces, at two
sizes, one of them partly hidden behind the badge.

`test/icons.test.js` asserts the invariant directly — the painted icon must contain exactly one
distinct colour, whatever the count.

---

## 4. Badge

The badge shows **the exact tab count**, on Chrome's own action badge.

| Property      | Decision                                                    |
| ------------- | ----------------------------------------------------------- |
| Text          | the exact count, e.g. `13` — never the state name, never `k` |
| Background    | the state's `color` — the bright hue                        |
| Text colour   | the state's `badgeText`, near-black                          |
| Position      | Chrome's own corner placement; not configurable             |

### Why the badge rather than digits in the icon

Chrome draws the action badge in its own typeface, at its own size, anchored to the corner of the
icon, and exposes no API to move or resize it. That is a limitation if you want a centred number,
and an advantage if you want a number that is simply correct: the platform renders it at every
scale, on every platform theme, in every locale, and it cannot drift out of alignment with
anything. The icon then only has to carry the silhouette and the colour.

### The text colour is not optional

Chrome's default badge text is **white**. All five badge colours are bright enough that white fails
badly on them — 1.75:1 on the yellow, 2.14:1 on the green. A badge left at the default would be
close to invisible in four of the five states.

`chrome.action.setBadgeTextColor` is therefore called on every refresh, with whichever of black or
white is more legible on that state's background. All five resolve to black, at 5.80:1 or better.
The colour is **derived**, not hand-written, for the same reason `iconColor` is: a hand-written
value that disagreed with its background would be invisible rather than wrong-looking.

`setBadgeTextColor` requires Chrome 110, so the manifest declares `minimum_chrome_version: "110"`
and the call is made **unconditionally**. Chrome then refuses installation on anything older,
rather than the extension loading and shipping an unreadable badge. A runtime feature check was
rejected for the same reason it is not needed here: it would convert a load-time guarantee into a
runtime branch that silently degrades.

### Counts above four digits

Chrome renders at most four badge characters, so a five-digit count is clipped by the platform.
The exact count is still what is sent, and the popup and the tooltip both report the true number.
This is a platform limit, not a formatting decision, so no abbreviation is applied — inventing one
would mean the badge and the popup disagreed about the same number.

---

## 5. Popup

Clicking the toolbar icon opens a minimal popup showing exactly three things:

1. Current tab count
2. Current state
3. One short explanation

Canonical copy, fixed by state:

| State             | Explanation |
| ----------------- | ----------- |
| Focused            | Your browser context is light, with little to keep track of. |
| Growing     | More information is building up in your browser context. |
| Crowded           | More information is making it harder to quickly find what you need. |
| Fragmented           | Different pages and tasks are competing for your attention. |
| Overloaded | There is a lot to organize, find, and return to. |

The popup must **not** contain: productivity scores, streaks, achievements, gamification,
motivational messages, sounds, notifications, AI, automatic tab closing, automatic bookmarking, or
tab recommendations.

Visual direction: a small browser instrument, not a productivity coach. Minimal, calm, immediate,
peripheral, non-judgmental. No alarmist language, no shame, no motivational copy, no claims about
cognition. The user should be able to glance at the toolbar icon and immediately understand the
current state without opening the popup at all.

---

## 6. Threshold toast

One line, on the page, at the moment the count crosses into a new state. It is
the only thing Tablox says without being asked, so the bar for saying it is high.

### When it speaks

| Situation | Toast? | Why |
| --------- | ------ | --- |
| Browser starts, extension installs, worker's own first breath | **No** | No tab event has happened yet, so there is no "before" to compare against. |
| Worker revived by a tab event after being evicted | **Yes** | The event says how far it moved the count, so the state it came from is known without remembering anything. See [Waking up](#waking-up). |
| Count crosses a threshold, upward | Yes | The state genuinely changed. |
| Count crosses a threshold, downward | Yes | So does a fall. The brief prefers upward, and this is the same rule applied in both directions. |
| Count changes within a state | **No** | `4 → 5` is not news. |
| A crossing already inside the cooldown | **No** | See below. |
| A burst of events | **Once** | See debouncing. |

Downward crossings are not softened. A single rule — "the state you settled on is
not the state you were in" — is easier to reason about than one with exceptions,
and the user cannot tell a rising count from a falling one at a glance anyway.

### Debouncing, and why not a cooldown alone

Opening five tabs fires five events in a few hundred milliseconds and can cross
two thresholds. Deciding on each event raises a toast per crossing; deciding
against a fixed cooldown from the first one announces the state the user passed
*through* rather than the one they are in — `3 → 7` in quick succession would say
"The hoarding has begun" and leave them in Crowded, unmentioned.

So the decision waits `TOAST_DEBOUNCE_MS` (400ms) for the events to stop, and is
made once against the settled state. `3 → 4 → 5 → 6 → 7` produces exactly one
line: Crowded's.

A 4-second `TOAST_MIN_INTERVAL_MS` cooldown sits underneath as a secondary guard
against a genuinely repeated crossing — hovering either side of a threshold, or
a user oscillating. The debounce handles a burst; the cooldown handles a pattern.
Four seconds is long enough that a deliberate second crossing gets its own line
and short enough that a user who has genuinely moved on is not still being told
about the last threshold they passed. It is deliberately *not* the same length as
`TOAST_MISS_WINDOW_MS`, below: a cooldown governs how often a line may be said,
while the miss window governs how long a line that was owed can still be
delivered, and those are not the same question.

A transition that was suppressed still counts as handled: the pending delta is
spent whether or not a toast went out, so the same line is never offered twice.

### Waking up

MV3 stops a service worker after about thirty seconds of doing nothing, so in
ordinary use nearly every crossing is announced by a worker that has been asleep
and remembers nothing. Anything the decision needs has to be derivable from what
the event itself says.

It is. `tabs.onCreated` means the count went up by one, `tabs.onRemoved` down by
one, and `onAttached`/`onDetached` — a tab moving between windows — not at all.
Sum the events since the last decision, subtract that from the count the browser
reports, and the state the count came from is known:

```
previous = getState(max(1, tabCount - pendingDelta))
```

Nothing is remembered, so nothing is lost when the worker is stopped, and no
permission is needed to fix it. The one case that genuinely has no "before" —
install, browser startup, and the worker's own first refresh — is the case with no
tab event in it, and stays silent.

The counter is deliberately in memory. The cooldown is a guard against nagging,
and a worker is only stopped after half a minute of doing nothing, by which point
whatever it last said is long past the four seconds the cooldown covers. So the
one case where forgetting it matters is one where it cannot.

### Getting it to a page that was not listening

The tab that crosses a threshold is usually the tab the user has just opened, and
that tab is still loading when the message goes out — its content script has not
run. So there are two routes, and the second is the one that matters:

1. **A short retry.** `TOAST_DELIVERY_BACKOFF_MS` (`0, 300, 900`) covers the
   ordinary cases: a tab that was already loaded — a crossing caused by *closing*
   a tab lands on a foreground tab that has been there all along — and a page a
   moment behind. The schedule is finite, which is what stops a `chrome://` page,
   a download or a dead connection from holding the worker awake.
2. **The tab asking.** A content script announces itself when it loads, and the
   worker hands over the crossing it missed. A retry is a guess about when a tab
   will be ready, and a slow page beats any guess; measured in real Chrome, the
   toast lands **1ms** after a page that took 2.5s to load is ready, where
   retrying alone left it 4 seconds late or absent altogether.

Only the tabs the crossing was aimed at may collect it, so a tab opened a moment
later — which crossed nothing — stays quiet. And whichever route arrives first
closes the other, so a page is never given the same toast twice. Both are
enforced in `test/toast.test.js` and counted in real Chrome.

**How long the offer stays open, and why four seconds was wrong.**
`TOAST_MISS_WINDOW_MS` is 30 seconds. The tab that opens a crossing is the tab
the user has just opened, and for a while that tab is not a page at all: it is
the New Tab page, which takes no content script and therefore never announces
itself. The offer is not waiting on the network — it is waiting on a person to
type or paste a URL, choose a bookmark, or read a page before moving on, and
that routinely takes longer than four seconds. Measured in Brave, opening a
fourth tab and then navigating it lost `"The hoarding has begun"` entirely at
four seconds, and delivered it at thirty.

Thirty seconds is also how long Chrome waits before stopping an idle MV3 worker,
so the offer cannot outlive the process that holds it. A long window is safe
because only the aimed tab may claim it, and any newer crossing replaces the
offer outright rather than queueing behind it.

### What it looks like

| Property | Value | Reason |
| -------- | ----- | ------ |
| Position | fixed, top centre | Out of the way, and the same place every time. |
| Lifetime | 340ms in, 2400ms, 260ms out | Three seconds end to end, timed by timers. |
| Background | the state's badge colour at 94% opacity | The badge pairing, so the page and the toolbar agree. |
| Text | the state's badge text colour | Legible on that colour by construction. |
| Shape | pill, `border-radius: 999px` | The badge's shape, at page scale. |
| Interaction | `pointer-events: none`, no listeners | Cannot block the page underneath. |
| Motion | slide down and fade in, reverse on exit | Enough to be noticed, not enough to interrupt. |
| Leaving | raced against a timer, never awaited alone | A hidden tab stops advancing the animation timeline, so only a timer can be relied on to remove the toast. |
| Reduced motion | animations collapse to 0ms | The line still appears and still leaves. |
| Announced | `role="status"`, `aria-live="polite"` | A screen reader hears it once, without being interrupted. |

Legibility is not assumed. The background is translucent over a page whose colour
Tablox does not control, so the real-browser check requires 4.5:1 against both a
white and a black page.

### What it will not do

- No stacking. A new toast replaces the one on screen; it does not queue behind it.
- No browser notification, no modal, no notification page, no sound.
- No dismissal control, and no way for a page to trigger one. Only the service
  worker sends `tablox:toast`, and the content script ignores anything else.
- No toast on a tab that cannot host it. `chrome://` pages, the Web Store and
  still-loading tabs simply do not get one, and the refusal is swallowed.

---

## 7. Technical requirements

| Concern       | Decision                                                     |
| ------------- | ------------------------------------------------------------ |
| Manifest      | Chrome Manifest V3                                           |
| Background    | Service worker (`background.service_worker`, `type: module`)   |
| APIs used     | `chrome.tabs`, `chrome.action`, `chrome.runtime`, `chrome.windows` |
| Permissions    | `tabs` **only** (plus all-sites content-script access for the toast) |
| Stack         | Vanilla JavaScript, HTML, CSS. No framework, no build step.   |

### Permissions

`tabs` is the minimum permission that permits counting all open tabs. `"activeTab"` cannot
enumerate tabs and is therefore insufficient.

Not requested, in any form:

- browsing history
- bookmarks
- `host_permissions`
- cookies
- `scripting`, `webRequest`, `debugger`

### The all-sites content script

The toast is the one feature that cannot live in the toolbar, so `src/manifest.json`
declares a single content script matching `<all_urls>`, top frame only, at
`document_idle`. Chrome presents this to the user as *"Read and change your data
on all websites."* That is a real cost and it is accepted deliberately, for a
toast, with these constraints:

- It runs on the top frame only. Not in iframes, so a page with a thousand
  embedded frames does not get a thousand listeners.
- It reads nothing. No text, no HTML, no attributes, no URL, no page state.
- It writes exactly one string into one element it created itself, using
  `textContent` and never `innerHTML`.
- It is `pointer-events: none` and registers no input listener, so it cannot
  intercept a click or a keystroke.
- Its styles live in a shadow root, so page CSS cannot restyle it and its CSS
  cannot leak out. Inherited properties are set explicitly, because inheritance
  does cross the boundary.
- It is top-centre and `position: fixed`, so it cannot affect page layout.
- It removes its own element, leaving the page as it found it.

The alternative — a `chrome.notifications` popup — was rejected: it is a browser
notification, moves focus, and is heavier than the thing it would be announcing.

The service worker sends the finished message. The content script holds no
thresholds, no colours and no copy, and cannot decide what Tablox thinks.

### Privacy constraints

- No external network requests of any kind.
- No analytics, telemetry, tracking, crash reporting, or user-data collection.
- Everything runs locally in the browser.
- Tablox **never inspects webpage contents.** It does not read URLs, page titles, or DOM. It uses
  only the tab count.
- No `chrome.storage`, no persistence. State is recomputed from the browser on every event.
- Nothing is written to disk, synced, or transmitted.

Holding no state costs nothing here, because the decision does not need any. A
tab event states its own size, so the state a count came from is arithmetic on
the live count rather than a memory of the last one — which is what lets a worker
that has just been evicted from thirty seconds of sleep announce the crossing
that woke it. See [Waking up](#waking-up). No `storage` permission, and no
second grant to explain.

The only tab queries issued are `chrome.tabs.query({})` and
`chrome.tabs.query({ active: true })`, which return bare tab records
(`id`, `index`, `windowId`, …). The extension reads the array `length` and nothing else.

---

## 8. Tab events

State refreshes when the tab set changes. Required events:

| Event                       | Trigger                                |
| --------------------------- | -------------------------------------- |
| `chrome.tabs.onCreated`     | tab opened                             |
| `chrome.tabs.onRemoved`     | tab closed                             |
| `chrome.tabs.onAttached`    | tab moved **into** a window            |
| `chrome.tabs.onDetached`    | tab moved **out of** a window, or window closed |

Initialization: correct state is established when the service worker starts, via
`chrome.runtime.onStartup`, `chrome.runtime.onInstalled`, and an immediate call at module load
(service workers are terminated and revived by Chrome, so state must be recomputed on every wake).

**No polling.** There is no `setInterval` and no `alarms` API. The only timer is
a single cancellable `setTimeout` backing the toast debounce, and the test suite
asserts that its callback cannot re-arm it — otherwise it would be a poll wearing
a disguise.

**Multi-window:** the count spans all windows. A tab moved between windows is removed from one
window and added to another, so the total is unchanged — the icon must not flicker or
change value across that move.

---

## 9. Architecture

```
src/
├── manifest.json
├── shared/
│   ├── state.js              getState(tabCount) — the ONLY threshold logic,
│   │                         plus the colour derivation (darkenToLuminance,
│   │                         bestTextOn, contrastRatio, relativeLuminance)
│   └── shape-icon.js         renders the icon's RGBA pixels
├── background/
│   └── service-worker.js     tab events → refresh() → action API, and the
│                             toast transition decision
├── content/
│   └── toast.js              draws one line on the page; reads nothing
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
    └── icon-{16,32,48,128}.png   manifest default only; the live icon is
                                   drawn at runtime by shape-icon.js
```

`shape-icon.js` is pure — no canvas, no font loading, no DOM — so the service
worker, the icon generator, and the tests all produce identical pixels.

The service worker is the single writer of the toolbar. It sets four things per
refresh, all from one `getState` result:

```js
chrome.action.setIcon({ imageData })                     // shape-icon.js @ 32px
chrome.action.setBadgeText({ text: String(tabCount) })
chrome.action.setBadgeBackgroundColor({ color: state.color })
chrome.action.setBadgeTextColor({ color: state.badgeText })
chrome.action.setTitle({ title })
```

The four badge/icon writes are issued in one `Promise.all`. They are independent
properties of the same button, so there is no ordering constraint between them,
and batching them means a single refresh cannot be observed half-applied by the
renderer.

The popup imports the same `state.js`. It does not re-derive state from thresholds; it reads the
count from the live browser and passes it to `getState`. It is read-only with respect to the
toolbar.

Colour lives in exactly one place. `state.js` exports the two colour helpers the whole extension
needs, and neither the worker, the popup, nor the tests contain a contrast or darkening formula.

The tab count flows through four responsibilities, each in one file, so that the
threshold, the copy, the decision and the drawing cannot drift apart:

```
countOpenTabs()            count every tab in every window
  ↓
getState(tabCount)         the only threshold logic; yields colour and copy
  ↓
shouldShowToast(from, to)  a pure transition rule: is this worth saying?
  ↓
pushToast(state) / toast.js  send it, then draw it
```

`shouldShowToast` is pure and takes its clock as an argument, which is why the
transition policy can be tested exhaustively without a browser and without
sleeping. The two timings it consults live beside it in `state.js` rather than in
the worker, so the rule and the numbers it depends on are read together.

---

## 10. Testing

Automated tests use Node's built-in test runner (`node:test`) with `node --assert`. **Zero runtime
and zero dev dependencies.**

### State calculation

Boundary coverage is mandatory: **3, 4, 6, 7, 9, 10, 12, 13**. Also covered: 0, 1, 2, 5, 8, 11, 99,
100, invalid input, and structural invariants (ascending non-overlapping ranges, unique ids, last
range open-ended, every state has all contract fields).

Copy is asserted as exact strings, not as substrings. The explanations are the product; a wording
drift is a product change and should fail the build rather than pass review.

### Colour guarantees

Asserted numerically, per state, against literal expected values — not against the values the code
derives, which would make a broken derivation agree with itself:

| # | Assertion                                                                   |
| - | --------------------------------------------------------------------------- |
| 1 | The five badge colours are exactly the literals in the §2 table            |
| 2 | The five icon colours are exactly the literals in the §2 table              |
| 3 | Each `iconColor` preserves the hue and saturation of its `color`            |
| 4 | Each `iconColor` clears 3:1 against **both** `#FFFFFF` and `#202124`         |
| 5 | Each `badgeText` clears 4.5:1 against its own `color`                        |
| 6 | `badgeText` is the more legible of black and white for that background       |
| 7 | The bright `color` is **not** used as the icon fill, per §2                  |

Point 7 is the one that is easy to regress: `color` and `iconColor` are adjacent fields and
swapping them in a single line leaves every other test green.

### Behaviour

Against a fake `chrome` API:

| # | Scenario                        | Assertion                                              |
| - | ------------------------------- | ------------------------------------------------------ |
| 1 | Tab creation                    | count and state advance                                |
| 2 | Tab removal                     | count and state recede                                 |
| 3 | Tab moving between windows      | count unchanged across attach + detach                 |
| 4 | Service-worker restart          | state recomputed correctly on load                    |
| 5 | Icon set                        | `setIcon` receives one 32px `ImageData`, state's fill  |
| 6 | Badge text                      | exact count, including `"0"`                           |
| 7 | Badge colours                   | background = `color`, text = `badgeText`               |
| 8 | Badge text colour is not optional | `setBadgeTextColor` is called on **every** refresh   |
| 9 | Title                           | count, state label, and explanation                    |
| 10 | Popup state                     | popup renders count, label, explanation for each state |
| 11 | No `windows` API                | falls back to `tabs.length`                            |
| 12 | No polling                      | source contains no `setInterval` / `alarms`            |
| 13 | No persistence                  | no `chrome.storage` anywhere in `src/`                 |
| 14 | Badge text is the bare digits    | no whitespace, padding, or unit suffix to shift it     |

Point 8 is asserted by counting calls, not by checking that the API is *available*: a
`if (chrome.action.setBadgeTextColor)` guard would satisfy an availability check while silently
producing an unreadable badge on an older Chrome. The manifest's `minimum_chrome_version` is the
place that decision belongs, and it is asserted separately.

### Icon rendering

Asserted on the pixels, not by eye:

| # | Assertion                                                          |
| - | ------------------------------------------------------------------ |
| 1 | Every pixel is one of exactly two values: full fill or full alpha 0 |
| 2 | The shape is a square of side `size - 2*EDGE_INSET`               |
| 3 | All four corners are rounded, each at `CORNER_RATIO * size`         |
| 4 | The corner diagonal pixels are transparent; the edge midpoints are not |
| 5 | Total coverage is 87.9% ± tolerance at 32×32                      |
| 6 | Coverage is identical across all five states — colour only varies  |
| 7 | Rendered alpha is binary, not blended — no half-lit edge pixels    |
| 8 | The four static manifest PNGs match the renderer byte for byte    |
| 9 | The shape is exactly centred: centroid and bounding box, at 16/32/48/128 and at odd sizes |

Assertions 1 and 6 together are the check that the icon carries no number: if a digit were drawn,
there would be a third distinct pixel value and the coverage figure would change with the count.
Coverage is computed independently in the test rather than compared to a value the renderer exports,
so a change to the geometry cannot quietly update the expectation at the same time.

### Manual verification

`docs/VERIFICATION.md` holds the Chrome procedure for what needs human eyes — real toolbar rendering
against both OS themes, badge legibility at the smallest supported scale, and
drag-a-tab-between-windows.

### The toast

Covered in three layers, because the toast is the only part of Tablox that acts
on its own and the failure mode is talking when it should not.

**The copy** is asserted as exact strings, with the specified punctuation, and
checked for the properties that must hold whatever the wording: no wrapping
quotation marks, one sentence, no more than twelve words, and no judgement
vocabulary. The judgement list is shared with the popup's through
`test/helpers/copy.js`, so the two cannot drift apart.

**The transition policy** is tested as a pure function, which is the reason it was
written as one:

| Case | Expectation |
| ---- | ----------- |
| `focused → growing` | speaks |
| `growing → growing` | silent |
| `overloaded → fragmented` | speaks (downward counts too) |
| `null → focused` | silent — no tab event yet, so there is no "before" |
| a crossing inside the cooldown | silent |
| exactly at `TOAST_MIN_INTERVAL_MS` | speaks — the boundary is inclusive |
| `lastShownAt` absent or null | speaks — the cooldown is measured from the last toast, not from boot |

**The behaviour against a fake browser** covers the scenarios the brief names:
3 → 4 speaks; 4 → 5 and 5 → 6 do not; 7 speaks; 10 speaks; 13 speaks. Plus the
burst (`3 → 4 → 5 → 6 → 7` yields exactly one line, and it is Crowded's), a
downward crossing, delivery to the foreground tab of every window and no
background tab, the payload carrying the state's own two colours, and a tab that
refuses content scripts being skipped without taking the refresh down.

Five of them exist because the feature was broken in ordinary use and the fix had
to be pinned down:

| Case | Expectation |
| ---- | ----------- |
| A worker given no baseline, and only the event that woke it | speaks — the previous state is arithmetic, not memory |
| A worker that has seen no events at all | silent — install and startup are not crossings |
| A tab still loading, out of reach of the retry, then announcing itself | speaks, when it asks |
| The same tab announcing itself after `TOAST_MISS_WINDOW_MS` | silent — a stale crossing is not news |
| A tab opened just after a crossing, announcing itself | silent — it was not the tab the crossing was aimed at |
| A page that answers the announcement while the retry is still queued | one toast, not two |
| A burst where the tab in front is still loading | the background tab gets nothing; the foreground one gets it |

Each of these was checked by breaking the thing it describes and watching the test
fail, so none of them is a test that passes either way.

The fake browser models two behaviours of its own that these tests depend on, and
both were added after a test failed for the wrong reason: a newly opened tab
becomes its window's foreground tab, and closing the foreground tab promotes a
successor. A fake that disagrees with Chrome about `active` is testing its own
assumptions.

**The content script** is verified where it actually runs, because a shadow root
and the Web Animations API are not things a unit test can meaningfully fake. The
static checks cover what must be true of the source — click-through, no input
listeners, `textContent` and never `innerHTML`, the hold window, self-removal,
reduced motion — and `npm run verify:chrome` covers the rest.

### Real-browser verification

`npm run verify:chrome` loads the extension into a real Chrome over the
DevTools protocol, opens a controlled number of tabs, and reads back what the
live browser actually holds. At each of ten counts — 1, 3, 4, 6, 7, 9, 10, 12, 13, 100 — spanning
every threshold boundary — it asserts:

- `chrome.tabs.query` reports the count that was opened
- `getBadgeText` is the exact count string
- `getBadgeBackgroundColor` is the state's bright colour
- `getBadgeTextColor` is set, and is the more legible of black and white for the background
  Chrome reports, clearing 4.5:1
- the painted icon is a two-value image: >800 fully-opaque pixels, zero fully-transparent, the
  1px margin transparent, the corner diagonals transparent and the edge midpoints opaque
- `setTitle` reports the true count even where the badge is clipped

`getBadgeTextColor` reports an unset colour as `[r, g, b, 0]`, so the harness
requires a non-zero alpha. Without that check an *unset* text colour is
indistinguishable from a deliberately chosen black, and deleting the
`setBadgeTextColor` call would pass while shipping Chrome's white default — an
invisible badge in four of the five states.

The checks are written as properties of the reported values rather than as
comparisons against the state table, so a table edited to say white agrees with
itself and the badge ships unreadable without the harness noticing.

**The toast** is checked in the same run, against a real page served from
`127.0.0.1` — content scripts are matched by URL, so `about:blank` cannot host
one. A page in its own window is therefore the foreground tab there, which is the
only way a toast is ever addressed. Ten checks:

1. a page opened at 2 tabs, still Focused, shows nothing
2. at 3 tabs, still Focused, still nothing
3. crossing to 4 tabs produces the Growing line, on the tab that did the crossing
4. the foreground tab of the *other* window receives it too — one per window
5. it removes itself, between 1.2s and 5s after appearing
6. a page that takes 2.5s to load — so it is not listening when the message is
   first sent — still gets it, and reports how long after the page was *ready* it
   arrived. It is checked against a marker element in the served page rather than
   `document.readyState`, because a target that has just been created is showing a
   blank document, and a blank document is `complete` two and a half seconds
   before the page is. Measuring from the wrong baseline turns a 1ms delivery into
   a suspicious-looking 2.5 second one.
7. that same slow page removes its toast, and a page-side observer confirms it was
   raised **once** — reading the DOM afterwards cannot tell one toast from two of
   the same text laid over each other
8. `5 → 6`, still within Growing, says nothing
9. the service worker can be stopped, and did stop
10. a worker woken by that eviction still announces the crossing — the case the
    whole feature turned on

Check 9 detaches the harness's own debugger session first, because a worker with
a debugger attached is not eligible to be stopped: holding on is the one thing
guaranteed to make the check prove nothing. It then waits for Chrome's real
thirty-second idle timeout, and confirms the target is gone rather than trusting
the request.

The third check reads the live shadow DOM through `getComputedStyle` and asserts
the text, the background as `rgba()` of the state's badge colour at 0.94, the
text colour, that it is `position: fixed` with `pointer-events: none`, that its
box is small and near the top of the viewport, that text at its centre resolves
through it to the page underneath, and that the result clears 4.5:1 against both a
white and a black page — the extremes of a background Tablox does not control,
which is the only version of that check that means anything.

Chrome removed the `--load-extension` switch in version 137, so the harness
loads through the `Extensions` domain over a debugging pipe. It is kept out of
`npm test` because it opens a real browser window.

### Mutation checks

A green suite proves the assertions run, not that they bite. Each of the
following single-line mutations was applied, the full gate re-run, and the
original restored:

| Mutation                                       | Caught by |
| ---------------------------------------------- | --------- |
| threshold `7–9` → `7–10`                       | unit      |
| `badgeText` forced to `#FFFFFF`                | unit + Chrome |
| icon filled with the bright `color`            | unit + Chrome |
| `bestTextOn` hardcoded to white                | unit      |
| `CORNER_RATIO` 0.0625 → 0.2                   | unit      |
| `EDGE_INSET` 1 → 0                             | unit      |
| `setBadgeTextColor` call deleted               | Chrome    |
| badge background forced to `#FFFFFF`           | Chrome    |
| badge text blanked                              | Chrome    |
| `setBadgeTextColor` wrapped in `&&` / `?.` / `if` | unit   |
| `minimum_chrome_version` lowered to `109`        | unit      |
| shape shifted down 1px (vertical off-centre)     | unit      |
| shape shifted right 1px (horizontal off-centre)  | unit      |
| badge text given a trailing space                | unit      |
| toast copy reworded                             | unit      |
| debounce removed, so every event decides         | unit      |
| debounce timer made non-cancellable              | unit      |
| debounce callback re-arms itself                 | unit      |
| `pointer-events: none` removed from the host    | real Chrome |
| retry schedule emptied **and** the arrival announcement removed | unit |
| the `landed` check removed from the retry chain | unit |
| the `aimed` check removed from `deliverCrossing` | unit |
| `TOAST_MISS_WINDOW_MS` expiry removed | unit |
| `TOAST_MISS_WINDOW_MS` shortened back to the 4s cooldown | unit, and Brave end-to-end |
| the toast's removal sequenced on `animation.finished` alone | unit, and real Chrome |
| content script's `tablox:ready` announcement removed | unit |
| `previousId` derived from `pendingDelta` replaced with `null` | unit |
| previous state kept in a module variable again (the original bug) | unit |
| `waitForToast` given a target id instead of a page session | real Chrome |
| worker kept attached by the harness, so it cannot be evicted | real Chrome |
| slow-page readiness measured from `document.readyState` | real Chrome |
| `scratch2` opened into the quiet page's window | real Chrome |

The first seven of those are the four bugs this feature actually had, each of which
shipped as "the toast does not work" rather than as a failing test. The last four
are the harness lying to itself: in every case the check failed for a reason that
had nothing to do with the product, which is the failure mode a verification
script is most prone to and least likely to be caught by re-running it.

---

## 11. Constraints on V0.1

The purpose of V0.1 is to test one behavioural hypothesis:

> Does a simple peripheral tab-count signal help the user voluntarily keep their active browser
> context smaller?

Everything not required to test that hypothesis is excluded. Do not over-engineer.

**One addition, and the reason it is not over-engineering.** The hypothesis is
about a *signal*. A tab count that silently becomes 13 is not a signal; it is a
number that was there all along, and the user has no way to know they passed
through three states while reading. The toast is what makes a crossing
perceptible at the moment it happens, so it is part of testing the hypothesis
rather than a feature beside it. It is held to the same line as everything else —
one line of copy, no history kept, nothing learned about the user — and the one
privilege it does claim, all-sites content-script access, is written down in §7
rather than left implicit.
