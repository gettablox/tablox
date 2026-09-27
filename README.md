# Tablox

A minimal browser signal showing how much browser context is currently open.

Tablox counts your open tabs and shows a small rounded square in the colour for
the current state, with the exact count on Chrome's own badge. When the count
crosses into a new state, it also says so — once, briefly, on the page you are
looking at.

|  Tabs | State      | Icon      | Badge     | Toast on opening                         | Toast on closing         |
| ----: | ---------- | --------- | --------- | ---------------------------------------- | ------------------------ |
|   1–3 | Focused    | `#109162` | `#19DF96` | Clean slate. Enjoy it                    | Clean slate. Enjoy it    |
|   4–6 | Growing    | `#2D79FF` | `#639CFF` | A few tabs never hurt                    | Making some room         |
|   7–9 | Crowded    | `#997D01` | `#FDCF06` | Things are starting to pile up           | The pile is shrinking    |
| 10–12 | Fragmented | `#D25C00` | `#FF6F00` | Tab archaeology begins                   | The excavation continues |
|   13+ | Overloaded | `#FF0911` | `#FF343A` | The browser has entered its archival era | The archive is shrinking |

The badge is the exact count. Click the icon for one short explanation.

Each state carries two colours on purpose. The badge is a self-contained pill, so
it uses the bright hue with near-black text. The icon sits on the Chrome toolbar,
whose background Tablox does not control and which follows your OS theme, so it
uses a darker version of the same hue — light enough to signal the state, dark
enough to stay visible against both a white and a dark toolbar.

## Why

The hypothesis under test:

> Keeping fewer simultaneously available tabs may reduce opportunities for task
> switching and help you stay with the current information.

Tablox is a signal, not a coach. It never closes, blocks, reorders, or
scores anything, and it never tells you that you are doing something wrong. It
makes no claim about cognition, working memory, or attention limits.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `src/` directory
4. Pin Tablox to your toolbar

Requires Chrome 110 or newer. Tablox sets the badge's text colour explicitly, an
API added in 110; without it Chrome's default white badge text would be nearly
invisible on the yellow and green badges.

## Use

- **The toolbar icon** is a 2px-cornered square whose colour is the state. It
  covers as much of the 32px canvas as an icon can while keeping a 1px
  transparent margin, so the anti-aliased edges are not clipped by Chrome's own
  resampling. Glance at it; that is the intended interaction.
- **The badge** is the exact tab count, on the state's bright colour. Chrome
  draws it in its corner, and renders at most four characters, so counts past
  9999 are clipped by the platform.
- **The tooltip** reports the exact count and state.
- **The popup** shows the count, the state, and one short explanation.

To change a threshold, edit `STATES` in `src/shared/state.js`. That is the only
place thresholds live. The icon colour and the badge text colour are *derived*
from each state's badge colour rather than written out by hand, so changing a hue
cannot silently break contrast on the toolbar.

## Development

```bash
npm test                 # 136 tests, no dependencies
npm run verify:manifest  # validate manifest against the spec
npm run verify:chrome    # real Chrome: icon, badge, title, and the in-page toast (opens a window)
npm run icons            # regenerate the static manifest default icons
```

The live icon is drawn at runtime by `src/shared/shape-icon.js` — pure pixel
generation, no canvas, no fonts, no DOM — so there is no build step and no
`npm run icons` needed after changing a colour. `npm run icons` only refreshes
the four static files the manifest points at, for the extensions page.

No build step. No dependencies. `src/` loads unpacked exactly as written.

## Privacy

Tablox counts **open tabs**. It does not read page content, URLs, or titles, and
it never inspects the DOM of a page. No network requests, no analytics, no
telemetry, no storage, no accounts, no sync. Everything runs locally in the
browser.

The `tabs` permission is the minimum needed to count every open tab across every
window. It is the only entry in `permissions`, and there are no host permissions.

**The one thing to know before installing:** the toast needs a content script, so
Tablox asks for access to all sites. Chrome will say *"Read and change your data
on all websites."* That access is used for one purpose — drawing the toast — and
it is worth being precise about what that does and does not involve:

| The content script | |
| --- | --- |
| Creates | one `<div>`, inside its own shadow root |
| Reads | nothing — no text, no HTML, no attributes, no URL, no page state |
| Writes | one string, via `textContent`, into that `<div>` |
| Listens for | nothing; no click, key or scroll handler |
| Intercepts | nothing — the host is `pointer-events: none` |
| Leaves behind | nothing — the element removes itself after about three seconds |

The service worker holds no state between events and there is no storage of any
kind, so nothing is written to disk, synced, or sent anywhere. The toast's text
and its two colours are decided in `src/shared/state.js` and sent to the page
already resolved; the content script cannot decide what Tablox thinks.

To count tabs alone and have no toast, remove the `content_scripts` block from
`src/manifest.json`. Nothing else in the extension depends on it.

## Documentation

| Document | Contents |
| -------- | -------- |
| [`docs/SPEC.md`](docs/SPEC.md) | Product and technical specification — the source of truth |
| [`docs/PLAN.md`](docs/PLAN.md) | Implementation plan and design decisions |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | Manual Chrome verification procedure |

## License

MIT
