# Tablox — Manual Verification

Verification happens in three layers:

| Layer | Command | Covers |
| ----- | ------- | ------ |
| Unit | `npm test` | State calculation, colour derivation and contrast, event wiring, icon geometry, popup and toast copy, transition policy, manifest, privacy |
| Real Chrome | `npm run verify:chrome` | Extension loads, worker starts, Chrome accepts the icon, painted pixels, badge text/colour/text-colour, title, and the in-page toast on a real page |
| Manual (this document) | — | Anything needing human eyes |

This document covers the last layer: the icon as rendered against both OS themes,
the badge as Chrome draws it, real multi-window dragging, and real service-worker
suspension.

> **Note:** Chrome 137 removed the `--load-extension` command-line switch.
> `npm run verify:chrome` works around this via the DevTools `Extensions` domain.
> The manual steps below are unaffected — `chrome://extensions` still works.

---

## 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `src/` directory — *not* the repository root

Expected: a **Tablox** card appears with no errors. Pin it to the toolbar
(right-click the toolbar → check **Tablox**).

**Stop here if any error is shown.** In Chrome, click the card's **Errors** button
to see which file failed.

If Chrome warns that the extension is not compatible, you are on a build older
than 110. Tablox declares `minimum_chrome_version: "110"` because it sets the
badge's text colour, an API added in 110. This is deliberate — see §3.

---

## 2. Verify permissions

On the `chrome://extensions` card, Tablox should show:

| Permission                 | Expected                       |
| -------------------------- | ------------------------------ |
| Read your browsing history | **absent**                     |
| Read and change your data on all websites | **present — this is the toast** |
| (nothing else)             | —                              |

**This one line is a deliberate trade, not an oversight.** The toast is drawn on the page, so
it needs a content script, so Chrome asks for all-sites access. Everything else Tablox does
happens in the toolbar.

To confirm the access is as narrow as documented: open any ordinary page, and in DevTools run

```js
document.getElementById('tablox-toast-host')   // null until a toast fires
```

Then cross a threshold. The element appears, is gone about three seconds later, and inspecting
it in the Elements panel shows one `<div>` containing a single `<div>` with one text node and a
shadow root. There is nothing else: no script reading the page, no fetch, no injected styles
outside the shadow root.

If you would rather not grant all-sites access, delete the `content_scripts` block from
`src/manifest.json` and reload. The tab counter and badge keep working; only the toast is lost.

---

## 3. Icon and badge at each state

Start with a single window. Open tabs until you hit each boundary and watch the
toolbar. **Both** the icon colour and the badge colour must change at exactly
these points, and only at these points.

| Tabs | Icon      | Badge    | State             |
| ---: | --------- | -------- | ----------------- |
|    1 | `#109162` | `#19DF96` | Focused            |
|    3 | `#109162` | `#19DF96` | Focused            |
|    4 | `#2D79FF` | `#639CFF` | Growing     |
|    6 | `#2D79FF` | `#639CFF` | Growing     |
|    7 | `#997D01` | `#FDCF06` | Crowded           |
|    9 | `#997D01` | `#FDCF06` | Crowded           |
|   10 | `#D25C00` | `#FF6F00` | Fragmented           |
|   12 | `#D25C00` | `#FF6F00` | Fragmented           |
|   13 | `#FF0911` | `#FF343A` | Overloaded |
|   20 | `#FF0911` | `#FF343A` | Overloaded |

The icon is a **square with all four corners rounded**, not a circle, and it
carries **no digits**. The count lives on the badge.

- [ ] The icon is a square with visibly softened corners, not a circle
- [ ] The corners are subtly rounded — closer to a plain square than to a
      squircle or a dot
- [ ] The icon is **larger** than it looks like it should be, filling nearly the
      whole 32px canvas apart from a hairline transparent margin
- [ ] There is a visible **badge** in the top-right corner with a bright
      background and **dark** text
- [ ] The badge text is the **exact count** — check 1, 3, 10, 12, 13, 20, and 100
- [ ] Badge text is dark on the bright badge, not white. White would be nearly
      invisible on the yellow and green
- [ ] The icon's shape and size are **identical** across all five colours — only
      the fill changes
- [ ] The icon is *not* the same brightness as the badge: the badge is vivid, the
      icon is noticeably darker, and that difference looks intentional
- [ ] Nothing animates or pulses
- [ ] The icon does not change shape, size, or position as the count changes

### Both OS themes

This is the check the automated tests cannot make, and the reason the icon has
its own darker colour rather than reusing the badge's.

- [ ] Switch macOS to **Light** and **Dark** (or Windows → Personalization →
      Colors), and confirm the icon is clearly visible in **both**
- [ ] In particular, check the **yellow** (`#997D01`) and **green** (`#109162`)
      states on a light toolbar — these are the two that would vanish if the
      bright badge colour had been used for the icon
- [ ] Check the icon at actual toolbar size, not zoomed in

The contrast guarantee is ≥3:1 against both a white and a dark toolbar, and the
tests assert that numerically. Judging whether it *looks* right on your display
is the human part.

### Very large counts

- [ ] Open ~100 tabs: the badge reads `100` and the icon is unchanged
- [ ] Hover the icon: the tooltip gives the **exact** count
- [ ] Chrome renders at most four badge characters, so a five-digit count is
      clipped by the platform. Confirm you are comfortable with the badge being
      the imprecise surface at that point — the tooltip and popup both give the
      true number, and no abbreviation is invented

---

## 4. Popup

Click the Tablox toolbar icon.

| Tabs | Expected popup |
| ---: | -------------- |
|    3 | `3` / **Focused** / "Your browser context is light, with little to keep track of." |
|    6 | `6` / **Growing** / "More information is building up in your browser context." |
|    9 | `9` / **Crowded** / "More information is making it harder to quickly find what you need." |
|   12 | `12` / **Fragmented** / "Different pages and tasks are competing for your attention." |
|   14 | `14` / **Overloaded** / "There is a lot to organize, find, and return to." |

- [ ] Exactly three pieces of information: count, state, one explanation
- [ ] The state's colour appears as a thin top rule and a small dot — and it is
      the **darker** icon colour, matching the toolbar icon
- [ ] No score, streak, achievement, chart, history, or button of any kind
- [ ] Tone is calm and descriptive — not instructive, not alarming
- [ ] No claim about focus, cognition, or memory limits; the "Overloaded"
      copy explicitly says tab count alone cannot measure cognitive load

Adjust the tab count while the popup is open, or close and reopen it: the count
must be current both ways.

### Zero tabs

- [ ] Close every window: the badge reads `0`, not blank. A blank badge and a
      badge reading zero are easy to confuse at a glance, so `0` is deliberate
- [ ] Reopen a window and the count returns to `1`

---

## 5. Multi-window counting

1. Note the toolbar with 3 tabs → badge `3`, green
2. Open a second window with 4 tabs → must read `7`, **yellow**
3. Open a third window with 5 tabs → `12`, **orange**
4. Close the third window → `7`, **yellow** again
5. Drag a tab from window 1 into window 2 → the icon must **not flicker or
   change value** (the total is unchanged; only its location moved)
6. Close an entire window → the count drops by that window's tab count

- [ ] The count spans all windows
- [ ] Moving a tab between windows does not change the number
- [ ] Closing a window updates the count immediately

---

## 6. Service-worker restart

Chrome suspends MV3 service workers after ~30 seconds of inactivity. This is
normal, not a bug.

1. Open 5 tabs → blue
2. Wait ~40 seconds without touching anything
3. Open 2 more tabs → must jump straight to yellow, `7`

The toolbar must be correct even though the worker was asleep, because Chrome
wakes it to deliver the event. Confirm on `chrome://extensions` → **service
worker** link that a fresh worker has started.

- [ ] No stale count after the worker has been suspended
- [ ] The badge and icon are both correct on the very first event after waking

---

## 7. The toast

The automated checks cover the text, the timing and the click-through. This
section is for the things a machine cannot judge: whether it is the right size,
whether it lands somewhere comfortable, and whether the animation is charming or
merely present.

Set up with a single window and one ordinary page loaded, so there is something
to read behind the toast.

### It stays quiet until you cross a threshold

Open tabs one at a time up to three. **Nothing should appear.** Then open the
fourth: *A few tabs never hurt* should arrive at the top of the page, in the
blue of the Growing badge, and leave about three seconds later without you having
touched anything.

### It does not repeat itself

With four tabs open, open a fifth and a sixth. Nothing. Open a seventh:
*Things are starting to pile up*. This is the single most important property of
the feature — if it says something on every tab, it will be turned off within a day.

### It handles a burst

From three tabs, open four more quickly, in under a second. You should get **one**
toast, and it should be *Things are starting to pile up* — the state you ended up
in — not *A few tabs never hurt*, which you passed through on the way.

### It says something different when you close tabs

This is the one that takes a second read to check, so check it deliberately. From
ten tabs, close one: *The pile is shrinking* — not *Things are starting to pile
up*. Then from thirteen, close one: *The excavation continues*, not *Tab
archaeology begins*.

The point is not the wording but the direction. The badge colour is the same
either way, because the state is the same; the line should not be. If closing tabs
gives you the rising line, the tool is congratulating you on the opposite of what
you just did, and that is worse than saying nothing at all.

From four tabs, close one: *Clean slate. Enjoy it* — the lowest state has one line
for both directions, because at one to three tabs there is nothing to make room
for. That is the only state where the two agree.

### It says nothing you have to dismiss

Watch the toast arrive and leave. It should not need a click, should not steal
focus, and should leave the page exactly as it found it. The page's own links and
buttons under the toast must remain clickable throughout — try clicking one while
it is on screen.

### It is legible on a light and a dark page

Open a white page and a dark page and cross a threshold on each. The line should
be readable on both. If it looks thin on the dark page, that is the backdrop
blur not doing enough.

### It is unobtrusive

The subjective check, and the one that matters:

- Does it cover content you were reading? It should sit above the fold, centred,
  and be small enough to ignore.
- Does the colour feel like part of Tablox, or like a notification from something
  else? It should read as the same instrument as the toolbar.
- Is three seconds about right, or is it clinging?
- Does the slide-in draw the eye without startling you?

### It does not follow you into restricted pages

Try a `chrome://extensions` tab, the Chrome Web Store, and a freshly opened tab
that has not finished loading. **No toast, and no error anywhere.** The tab
counter and badge must keep working in those tabs regardless — the toast is a
nicety and must never be the reason something breaks.

### More than one window

Open a second window and put an ordinary page in it. Cross a threshold. A toast
should appear in the foreground tab of **each** window, and in no background tab.

### If you turned on reduced motion

macOS: System Settings → Accessibility → Display → Reduce motion. Cross a
threshold. The line should still appear and still leave, with no slide or fade.

---

## 8. Privacy spot-check

1. `chrome://extensions` → **Tablox** → **service worker** → open DevTools
2. In the Console, run:

   ```js
   await chrome.tabs.query({})
   ```

   Inspect the result. Tablox reads only the **length** of this array.

   The only other query it issues is `chrome.tabs.query({ active: true })`,
   to find the foreground tab of each window so the toast has somewhere to go.
   Neither form returns page content — the records carry an id, a window id, an
   `active` flag, an index, a title and a URL, and Tablox reads none of the last
   two.

3. Open the Network tab in that DevTools and switch tabs a few times. It stays
   empty — Tablox makes no network requests at all.
4. Open the popup's DevTools. The only network entry is `popup.html` and its
   local assets.
5. `chrome://extensions` → **Details** → confirm there is no "Collect usage
   data", and that site access reads "On all sites" — that is the toast, and §2
   explains it.
6. In the service worker console:

   ```js
   await chrome.storage.local.get(null)   // {}
   await chrome.storage.sync.get(null)    // {}
   ```

   Both empty, always. There is no `storage` permission, so this is a
   double-check rather than a real possibility.

- [ ] No network traffic from the worker
- [ ] No page content, URL, or title is read
- [ ] Nothing is stored or synced
- [ ] The all-sites grant is the toast, and the toast does nothing else

---

## 9. Reload resilience

1. On `chrome://extensions`, click **Reload** on the Tablox card
2. The toolbar must be correct immediately — icon and badge both reflecting the
   true current tab count, not a reset, a stale value, or a default icon with no
   badge
3. Fully quit Chrome and reopen it
4. Tablox's toolbar icon and badge must again show the correct state and count

---

## Result

All checks passing means the build satisfies `docs/SPEC.md`.

If any check fails, do not adjust the product — fix the code, or update
`docs/SPEC.md` deliberately and re-run `npm test`.

To see what is actually being asserted, and to confirm the assertions would
notice if the code were wrong, see the "Mutation checks" table in `docs/SPEC.md`
§10.

The automated layers currently report: `npm test` 136 passing, `npm run
verify:manifest` 34 checks, `npm run verify:chrome` 10 toolbar and 10 toast
checks.
