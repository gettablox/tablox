# Tablox — Implementation Plan

Derived from `docs/SPEC.md`. Smallest plan that satisfies the specification. No speculative work.

## Principles

1. **One source of truth.** `src/shared/state.js` owns every threshold *and* every colour. Nothing
   else states a number or picks a colour.
2. **No dependencies.** Extension runtime and test suite use only Node/Chrome built-ins.
3. **No build step.** `src/` loads unpacked exactly as written.
4. **No scope beyond the spec.** Each step traces to a section of `docs/SPEC.md`.

## Steps

| #   | Step                                        | Spec ref | Done when                                             |
| --- | ------------------------------------------- | -------- | ----------------------------------------------------- |
| 1   | Repo scaffold                               | —        | git repo, `.gitignore`, `package.json` on `main`      |
| 2   | Specification                               | all      | `docs/SPEC.md`, `docs/PLAN.md` written before code    |
| 3   | `src/shared/state.js`                       | §2       | `STATES` + pure `getState` + colour helpers           |
| 4   | `src/manifest.json`                         | §7       | MV3, `permissions: ["tabs"]`, `minimum_chrome_version`|
| 5   | `src/background/service-worker.js`          | §8, §9   | 4 tab events + startup → `refresh()`; no polling      |
| 6   | `src/shared/shape-icon.js`                  | §3       | pure RGBA renderer, rounded square, 1px inset        |
| 6b  | `scripts/generate-icons.mjs`                | §3       | 4 static manifest defaults, shared renderer          |
| 7   | `src/popup/`                                | §5       | count + label + one explanation, canonical copy       |
| 7b  | `src/content/toast.js`                      | §6       | one line on the page; reads nothing, removes itself    |
| 7c  | `shouldShowToast` + debounce in the worker  | §6       | pure transition rule; one toast per settled state     |
| 8   | `test/state.test.js`                        | §10      | boundaries 3/4/6/7/9/10/12/13 + colour guarantees    |
| 9   | `test/service-worker.test.js`               | §10      | create/remove/move/restart + icon, badge, title       |
| 10  | `test/popup.test.js` + `icons.test.js`      | §10      | popup copy; shape geometry and coverage on pixels    |
| 10b | `test/toast.test.js`                        | §10      | copy, transition policy, delivery, burst, refusals   |
| 11  | Validation scripts + `npm test`             | §7, §10  | green suite; manifest asserted valid                  |
| 12  | `scripts/verify-in-chrome.mjs`              | §10      | real Chrome: icon, badge, title **and the toast**     |
| 13  | `docs/VERIFICATION.md`                      | §10      | manual Chrome procedure written                       |
| 14  | Load in Chrome, verify by eye               | §9       | real toolbar icon matches spec                        |

## Key design decisions

**Module service worker.** `"type": "module"` lets the worker `import` `shared/state.js`
directly, so popup and background provably share one definition. Costs nothing; MV3 supports it.

**Event-driven only.** `onCreated`, `onRemoved`, `onAttached`, `onDetached` each call `refresh()`,
which re-queries the tab list and re-applies state. Chrome suspends the worker freely, so state is
recomputed on every wake rather than cached. There is no `storage` and nothing to go stale.

**Multi-window.** `chrome.tabs.query({})` is inherently cross-window. `countOpenTabs()` prefers
`chrome.windows.getAll()` (one IPC) and falls back to `tabs.length` when the `windows` namespace is
unavailable, e.g. in tests.

**`chrome.action` over `chrome.browserAction`.** MV3 deprecates `browserAction`; `action` is
correct and is what the spec requires.

### The icon

**All four corners are rounded, and the radius is 2px.** The brief asked for a square with rounded
corners; 2px softens an aliased corner point without turning the form into a squircle. The radius is
held as `CORNER_RATIO = 2/32` rather than a pixel count, so the 16px and 128px manifest icons keep
the same visual weight instead of looking razor-sharp at 16px and bloated at 128px. A larger radius
was the alternative reading of "maximum area"; rejected, because at 16px anything past ~2px stops
reading as a square.

**"Maximum area" is bounded by a 1px inset.** The shape fills the canvas except a one-pixel
transparent ring, giving 87.9% coverage at 32px. The margin is not cosmetic: a shape that bleeds to
the very edge has its anti-aliased corner pixels clipped by Chrome's own resampling, which shows as
a faint dark fringe on a light toolbar. One pixel moves the edge off the clip boundary while still
covering most of the canvas.

**The icon is rendered, not shipped.** `shared/shape-icon.js` rasterises into a plain RGBA buffer and
the worker hands that to `setIcon` as `imageData`. The renderer uses no canvas, no font loading, and
no DOM, so the service worker, the icon generator, and the tests all produce identical pixels with
no platform differences. Anti-aliasing is a 4×4 supersample folded down to binary alpha, which is
what keeps `test/icons.test.js` able to assert exactly two pixel values in the finished image.

### The badge

**The count moved from the icon into Chrome's badge.** The shape carries no text. An icon that also
drew digits would show the number twice, in two typefaces at two sizes, one of them partly hidden
behind the badge.

**Chrome's badge typography is borrowed; its geometry is not negotiable.** Chrome anchors the badge
to a corner and exposes no way to move or resize it. That is a limitation if you want a centred
number and an advantage if you want a *correct* one: the platform renders it at every scale, theme,
and locale, and it cannot drift out of alignment. So the icon only has to carry silhouette and
colour. A transparent badge background was tried and dropped — with nothing behind it, a corner
number is just a stray fragment of text overlapping the icon.

**The badge text colour is set explicitly, every time.** Chrome's default badge text is white, and
all five badge colours are bright enough that white fails on them (1.75:1 on the yellow, 2.14:1 on
the green). A badge left at the default would be close to invisible in four of the five states. So
`setBadgeTextColor` is called unconditionally, with whichever of black or white is more legible —
all five resolve to black, at 5.80:1 or better.

**The API version requirement is enforced by the manifest, not by a runtime guard.**
`setBadgeTextColor` needs Chrome 110, so `minimum_chrome_version: "110"` is declared. An
`if (chrome.action.setBadgeTextColor)` guard was considered and rejected: it would turn a load-time
guarantee into a runtime branch that silently degrades to an unreadable badge, and a badge you
cannot read is worse than a browser that refuses to install the extension. The unit suite asserts
the call happens on every refresh, so a reintroduced guard fails the build.

### Why the toast is a content script, and why that is a real cost

**The toast cannot live in the toolbar, so it has to be drawn on the page.** That makes
all-sites content-script access unavoidable, and it is the one place this extension asks for
something it could technically do without. It was worth asking whether the toast could be a
`chrome.action` badge change, a `chrome.notifications` popup, or nothing at all.

Notifications were rejected: they are heavier than the thing they announce, they can take
focus, and the brief rules them out. "Nothing at all" was rejected on the merits — the
hypothesis is that a *signal* changes behaviour, and a count that silently becomes 13 is not a
signal. Doing without would have saved the permission and quietly weakened the thing being
tested.

So the grant is accepted, and paid for with constraints rather than caveats: top frame only,
reads nothing, writes one string with `textContent`, no input listeners, `pointer-events: none`,
styles in a shadow root, and it removes its own element. The service worker resolves the text
and both colours before sending, so the content script holds no thresholds and cannot decide
what Tablox thinks. Removing the `content_scripts` block leaves a working tab counter, which is
the escape hatch if the cost is not worth it to someone.

**The worker holds nothing it needs between events, so nothing is lost when it is stopped.** An
MV3 worker is evicted after about thirty seconds idle, so almost every crossing is announced by
one that was asleep — a design that needed the previous state in a module variable would miss
every one of them, which is how the toast read as "not working" rather than as a bug. The fix
was to notice that a tab event states its own size: `onCreated` is `+1`, `onRemoved` is `-1`, a
move between windows is `0`. Summed since the last decision and subtracted from the live count,
that gives the state the count came from — arithmetic, not memory, and no `storage` permission.
The only genuinely unknowable case is having seen no tab event at all, which is install and
startup, and which stays silent.

**The decision is debounced, not rate-limited.** A cooldown alone announces the state the user
passed *through* — `3 → 7` in quick succession would say "A few tabs never hurt" and leave
them in Crowded, unmentioned. Waiting 400ms for the events to stop and then deciding once
against the settled state gets `3 → 4 → 5 → 6 → 7` down to one line, and the right one. The
4-second cooldown stays underneath for a genuinely repeated crossing. It is not the same length as the
window in which an unready tab may still collect a crossing, because those answer different questions:
the cooldown governs how often a line may be said, the miss window how long an owed line can still
arrive.

**The line depends on the direction, and the direction is already known.** Adding and removing a tab
crosses the same thresholds, so the first version had one line per state and used it for both. That
is wrong in a way the threshold test cannot see: a state is a range, and a range does not record
whether the count got there by opening or by closing, so someone tidying up was told their pile was
growing. Each state now carries a second line, chosen by the sign of the same delta that recovers
the previous state — which means the direction costs no extra memory, and a burst that both opens and
closes speaks for the net movement rather than for whichever event fired last. `Focused` is the one
state where the two lines coincide, because at one to three tabs there is nothing to pile up and no
room to make.

**The page that crossed is the page that is still loading.** The tab the user just opened is the
one that crosses the threshold, and it has no content script yet when the message goes out, so
delivery needs a second route. A short bounded retry covers the ordinary cases; for the rest, the
content script announces itself when it loads and the worker hands over the crossing it missed.
Only tabs the crossing was aimed at may claim it, and the first route to arrive closes the second,
so no page is told twice.

**The offer has to outlast the human, not the network.** This is where the feature was actually
broken in the field. For a while, the tab that opens a crossing is not a page at all — it is the
New Tab page, which takes no content script and so never announces itself. The offer was therefore
not waiting on the network; it was waiting on a person to type or paste a URL, choose a bookmark, or
read the page before moving on. At four seconds that routinely outlasted the offer, and the line was
lost on the one page that had every right to it. The window is now thirty, which is also how long
Chrome waits before stopping an idle MV3 worker, so the offer can never outlive the process holding
it. A long window is safe because only the aimed tab may claim it, and any newer crossing replaces
the offer outright rather than queueing behind it.

**`shouldShowToast` is pure and takes its clock as an argument.** That is what lets the whole
transition policy — baseline, same-state, upward, downward, cooldown boundary — be tested
exhaustively without a browser and without sleeping. It is also why the two timings live in
`state.js` beside it rather than in the worker: the rule and the numbers it reads are read
together or not at all.

### The two colours per state

**The icon is a darkened derivative of the badge, not a second hand-picked colour.** The badge sits
on its own background and is as bright as it likes. The icon sits on the Chrome toolbar, whose
background Tablox does not control and which follows the OS theme — WCAG 1.4.11 asks 3:1 for a
non-text graphic, and four of the five bright hues fail that on a light toolbar. So `iconColor` is
computed from `color`: same hue and saturation, at a lightness solved for a relative luminance of
0.215, landing every state near 4:1 against both `#FFFFFF` and `#202124`.

Deriving rather than writing both out means editing a hue in `STATES` cannot silently break the
contrast guarantee. Working in HSL rather than scaling RGB channels is what keeps a darkened orange
orange instead of brown. `badgeText` is derived the same way, for the same reason: a hand-written
value that disagreed with its background would be *invisible* rather than merely wrong-looking.

### Lessons from getting this wrong

**A harness that replaces the API it is testing proves nothing.** An early `verify-in-chrome`
swapped out `setIcon` to read pixels back, so it never saw Chrome reject the array of `ImageData`
it was handed — the toolbar silently fell back to the default icon and the harness still reported a
clean 9/9. The harness now calls through to the real API and asserts the promise resolves.

**A check that compares against the value under test is circular.** The badge legibility check
originally asserted `getBadgeTextColor()` equalled `state.badgeText`. A state table edited to say
white would then agree with itself, and an unreadable badge would ship green. The harness now checks
the *property* — that the text is legible on the background Chrome reports, and that it is the
better of black and white.

**Chrome reports an unset colour as `[r, g, b, 0]`.** Deleting the `setBadgeTextColor` call left
`getBadgeTextColor` returning `[0,0,0,0]`, which a naive RGB-only read treats as deliberate black —
so the mutation passed. The alpha channel is the only signal distinguishing "never set" from "set to
black", and the harness now requires it to be non-zero.

**A green suite proves the assertions run, not that they bite.** Every colour, threshold, and badge
call in this codebase has had a single-line mutation applied and the full gate re-run, to confirm
something catches it. The list is in `docs/SPEC.md` §9.

**Only four static files remain.** `scripts/generate-icons.mjs` writes the manifest default at 4
sizes — the Focused-coloured shape, no badge — so Chrome has something to show in the split second
before the first `setIcon` lands. It calls the same renderer, so the default cannot drift from the
live icon.

**Popup reads live.** The popup queries the tab count itself and calls `getState`. It never caches
and never writes the toolbar, so the toolbar has exactly one writer.

## Explicitly not doing

No framework. No bundler. No transpiler. No linter config. No CI. No release or zip script. No
`chrome.storage`. No options page. No internationalisation layer. No README badges or marketing.
These are all addable later without rework; adding them now would be over-engineering V0.1.

## Risks

| Risk                                          | Mitigation                                                    |
| --------------------------------------------- | ------------------------------------------------------------- |
| Popup and worker drifting apart on thresholds | Both import the same module; a test asserts one shared source  |
| Icons subtly differing per state              | One generator, one geometry, 4 colour swaps                    |
| A colour swap putting the icon on the wrong surface | `iconColor` derived from `color`; contrast asserted on both  |
| Icon invisible on a light or dark toolbar      | Every state asserted ≥3:1 against both `#FFFFFF` and `#202124` |
| Badge unreadable                              | `badgeText` derived; `setBadgeTextColor` asserted on every call; Chrome 110 enforced in the manifest |
| Worker asleep when a tab event fires          | Chrome wakes the worker to deliver the event; refresh on load |
| `tabs` permission reading as excessive        | Documented in SPEC §6 as the minimum that permits counting    |
