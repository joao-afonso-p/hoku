# Constellation layout

The constellation is Hoku's identity and its spatial memory. It is a **pure, deterministic
function** of the data plus the visibility settings. There is no physics simulation, no
randomness and no stored per-node coordinates.

Code: `src/features/constellation/layout.ts` (tests: `layout.test.ts`) and
`src/features/galaxy/visibility.ts` (tests: `visibility.test.ts`).

## What is drawn: the visibility model

The Galaxy represents **current work**, not the archive. Every view (map, lists, counts)
asks one function, `visibilityReason(session, settings)`:

| Reason | Rule | Zone |
|---|---|---|
| `live` | needs you (always), or live now (working / ready / idle / error) if *Always show live* is on | Live |
| `recent` | `lastActivityAt` inside the recent window (3 / 7 / 14 / 30 days, default 7) | Recent |
| `favorite` | favorited, if *Always show favorites* is on, however old | Older (drawn as pinned) |
| `archive` | anything else, only in **All** mode | Older |
| `hidden` | anything else in **Current** mode | not drawn |

Runtime state and recency are independent: an old session can be working, and a recent one
offline.

Inside the **Live** zone, runtime state sets the radius (`urgency` in `LayoutInput`): Needs
You sits closest to the core, then errors, working, ready and idle. Provider still sets the
angle. The status filter (Galaxy `Status ▾`, quick filters) **never changes positions**:
non-matching sessions fade to ~14% and projects without a match to ~16%, in place.
Recency uses the provider's own `lastActivityAt`, never Hoku's import time. Manual
sessions, which have no provider timestamp, use the time you added them.

- **Current** (default) shows live + recent + favorites.
- **All** shows everything. Older sessions sit in the outer zone, quiet.
- **`+N older`** (Project Focus) temporarily reveals one project's archive without switching
  the whole Galaxy to All.
- Search (⌘K) always covers every indexed session. ⌘↵ on a hidden session reveals it.

Settings keys: `galaxy.mode`, `galaxy.recentWindowDays`, `galaxy.alwaysShowActive`,
`galaxy.alwaysShowFavorites`, `galaxy.hideInactive`, `galaxy.ambience` (hub DB `settings` table).

The Galaxy is for spatial understanding, not chronology. It has no "latest first" or
"last hour" controls. Recency only shapes radius and luminance. To find recent sessions,
use **Sessions** (sorted by last activity), **Activity** (the timeline) or **⌘K**.

### Inactive and archived projects

- **Inactive** (nothing on the Current map) projects **stay in place**, so you learn where
  each project lives. Their core drops to ~22% with no halo, and the name stays readable at
  ~46%. Hover brings them back up. *Settings → Hide inactive projects* (off by default)
  removes them from Current. Every other project keeps its slot, so nothing reshuffles; the
  focused or expanded project never disappears.
- **Archived** projects leave the Galaxy entirely, but keep their slot, root and sessions.
  Restoring puts them back exactly where they were. Their sessions aren't drawn and don't
  spill into Unsorted. They stay in Sessions, ⌘K, Activity and Needs You.

## Coordinate spaces

- **World space**: galaxy coordinates. Project systems live here.
- **Focus units**: offsets of sessions from their project core, at Project Focus scale.
- **Screen space**: what the SVG renders. Node radii and labels are sized in screen
  pixels, so glyphs and text stay crisp at every zoom. Only positions are projected.

In Galaxy View a system is drawn at `GALAXY_SCALE = 0.56` of its focus size (Unsorted at
72% of that). Entering a project interpolates the scale to `1` (`t`: 0 → 1). At the same
time the other systems are pushed away (`×(1 + 3.2t)`) and fade out. It's one continuous
zoom, not a view swap.

## Galaxy: project positions

Each project has a **slot**: the smallest free integer ≥ 1, assigned once and stored in
SQLite. Slots sit on a golden-angle spiral:

```
r = spacing · √(slot − 0.6)       θ = slot · 137.5° − 90°
x = 1.12 · r·cosθ + jitter(id)     y = 0.8 · r·sinθ + jitter(id)
```

`spacing` scales the whole spiral **uniformly**, sized to the largest visible system:
`clamp(maxExtent · GALAXY_SCALE · 2 + 92, 205, 700)`. In Current mode systems are small,
so the galaxy tightens. In All it opens up. The arrangement (who sits next to whom) never
changes, only its size, so spatial memory holds across modes.

**Unsorted** takes the spiral slot after the last project. It stays present but is never
central, and it's drawn compact and dimmed so it can't dominate by volume.

## Sessions: angle = provider, radius = relevance

### Provider sectors

Providers present in a project divide the circle in fixed canonical order (Claude Code,
Claude, Codex), rotated by `hash(projectId)`. Sector width is proportional to a quantized
weight, `floor(log2(count)) + 1`, so boundaries only move when a provider crosses
1, 2, 4, 8, 16, 32… sessions. Sectors keep a small padding on each side, but there are no
drawn walls. It's a constellation, not a pie chart. Inside a sector, angle is
`hash(sessionId, "angle")`.

### Zones

| Zone | Contains | Radius (focus units) | Opacity |
|---|---|---|---|
| Live | running / open | 96–136 | 1 |
| Recent | inside the window | 178–292; fresher is closer (`recency` 0 → 1 across the window) | 1 → 0.72 |
| Older | archive, old favorites | 352–426 | 0.36 (favorites 0.62) |

Radii are multiplied by a quantized density factor: 1 (≤16 visible), 1.2 (≤32), 1.42 (≤56),
1.7 (more). Node size is `4.4 + 2.8·weight`, +1 for Live, ×0.8 for Older.

Recency moves a session gently outward through the Recent zone over the window. That's
deliberate, because distance means relevance. Crossing a zone boundary happens when
meaning changes: it stopped being live, or it left the window.

### Collision strategy

Hash placement is followed by a deterministic relaxation (≤60 iterations, **id order**).
Pairs closer than 36 units are pushed apart, and each node is then clamped back into its
own zone and sector.

## Labels and progressive disclosure

`placeLabels` (`labels.ts`) places labels greedily by priority: selected, then hovered, then
live, then waiting, then zone, then favorite, then opacity. It never overlaps another label,
a node, a core, a zone/sector annotation or a side panel. Labels that don't fit are hidden,
and hover always reveals them.

- **Galaxy**: project names plus "N current · M total". Live sessions are labeled, since
  they answer "what am I working on". The rest appear when you zoom in or hover a system. A
  project with nothing current recedes but stays clickable.
- **Focus**: zone names (LIVE / RECENT · 7 DAYS / OLDER or PINNED) and provider sector
  names are fixed obstacles. In a project with more than 8 older sessions, older labels
  appear only on hover, so the archive never dominates.

## Stability guarantees (tested)

- Same input gives the same output, regardless of input order.
- Between sector thresholds, adding a session moves at most a few neighbours, each by less
  than one separation distance.
- Zones nest: live inside recent inside older. Fresher recent sessions sit closer.
- A provider's sessions stay angularly clustered.
- 60+ sessions keep their separation.
- Project slots never change. Spacing changes scale the spiral without reordering it.

## Motion

Motion means something changed. Two kinds, kept separate:

**Semantic motion** (always on, except reduced motion):

| When | What | Where |
|---|---|---|
| Working | slow breathing halo (4.8 s), subtle luminance | `.breathe` |
| Project has working sessions | weaker, slower breath on the core ring (6.4 s) | `.breathe-core` |
| → Needs You | amber fades in (520 ms) with one slight swell (1.1×, 320 ms), then a steady halo | `.attention-in`, `.halo-in` |
| → Working / Ready / Error / Needs You | one soft ripple (1.1 s), coloured by the new state | `.ripple` |
| → Idle / Offline / Unknown | nothing (going quiet isn't news) | |

Transitions are detected by comparing each drawn session's status between data updates
(`motion.ts`). First paint and unchanged reloads never animate. Ready settles static.

**Ambient motion** (*Settings → Galaxy ambience*: `Still` | `Subtle motion`) only ever
moves the background, never project or session nodes.

With `prefers-reduced-motion`, all ambient motion is off. Ripples, swells and breathing are
removed, and the Needs You fade shortens to 160 ms. State stays clear from colour and shape.

## Background

"Deep space as an information canvas": near-black graphite, three layers from far to near
(`Starfield.tsx`).

- **Glows:** 3 huge, diffuse light fields in muted palette hues (starlight, slate blue,
  dusty violet). At these alphas an 8-bit gradient bands into visible rings, so the layer is
  computed once per size at ¼ resolution with dithering and scaled up smoothly.
- **Dust:** 520 sparse sub-pixel grains per 512 px tile.
- **Stars:** the original 70 faint stars per 900 px tile.
- **Near stars:** 16 slightly brighter stars per 1300 px tile, with the most parallax. The
  two star layers sliding past each other is what reads as depth.

Each layer has its own camera parallax (0.05 / 0.1 / 0.18 / 0.3). *Subtle motion* adds:
- drift from two incommensurate sines per axis with 113–337 s periods, so it never visibly
  loops. Amplitudes are 18–40 px (glows travel ~⅓ of theirs), so the near stars move at
  most about 1.6 px/s.
- cursor parallax of 12–36 px (glows ~⅓), eased over about a second.

All of these live in `LAYERS` in `Starfield.tsx`; tune there.

Intensity: the glows were tuned by measurement. At the point they first "looked right" they
added +4–7 levels over the base colour; they were then halved to about +0.5–1.5 levels, with
no edges in a brightness profile. The motion was tuned in the other direction. The first
pass (≤ 5 px, < 0.2 px/s) was below perception, and with ambience on you couldn't see any
movement, so it was raised (drift 7–18 px, 71–211 s periods, cursor 6–22 px). That was still
too subtle to read as intentional, so amplitude was raised again ×2–2.5 with periods
stretched ×1.6, keeping speed nearly as slow, to the values above. At the 2nd pass, over 8 real seconds, 0.2% of pixels change,
and project and session nodes never move.

**Default: Subtle motion.** `Still` is one click away in Settings.

## Future clustering strategy

If a system passes ~100 visible sessions, collapse each sector's Older zone into an
"N older" cluster that expands in place. Hash angles guarantee revealed nodes reappear where
they were.
