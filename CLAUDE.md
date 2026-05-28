# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**Hamlet Havoc** is a single-player, browser-based real-time strategy game with a
medieval/fantasy theme. The player manages a hamlet through a four-season yearly
cycle: gathering resources, training units, constructing buildings, and defending
against end-of-year events.

**The full game design is in [`docs/hamlet_havoc_req.md`](docs/hamlet_havoc_req.md)** —
that document is the single source of truth for game rules, stat tables, and the
milestone plan. Section references like "§7.2" throughout the code point to it.
This file covers only what's specific to working in the codebase; consult the req
doc for *what* the game should do.

## Commands

TypeScript + Vite project in development; `npm run build` bundles to the plain
static HTML/JS/CSS that actually ships (req §2.8 — no runtime dependencies).

```bash
npm install        # one-time
npm run dev        # Vite dev server with HMR
npm run build      # type-check (tsc --noEmit) + production bundle to dist/
npm run preview    # serve the production build
npm test           # Vitest headless sim tests
npm run typecheck  # tsc --noEmit only
npm run test:e2e   # Playwright browser play-tests (boots Vite, drives Chrome)
npm run test:all   # Vitest + Playwright back-to-back
```

## Architecture

Client-side game in TypeScript under `src/`, bundled by Vite into static files.
No backend. The core invariant (req §2.6) is a **strict sim/render/input split**:

- `game/` — the simulation core. Imports nothing from `render/` or `ui/`, holds
  no DOM/canvas references, advances as a pure `update(state, commands, dtTicks) → state`.
- State is plain, **id-based, JSON-serializable** data (no class instances, no
  cross-entity object references — relationships are integer ids).
- All randomness draws from a **single seeded PRNG** whose state lives in
  `GameState` (req §2.7). Never call `Math.random()` in the sim.
- Time is measured only in **ticks** (30/sec); durations are authored in seconds
  in `config/` and converted once. Never use wall-clock time in the sim.
- Stat tables live as **data in `config/index.ts`** (the single tuning point),
  not as numbers hardcoded across logic.

### Module Structure

```
src/
  main.ts            — bootstrap; fixed-timestep loop (30 ticks/sec), persistence wiring, dev-only window.__game hook
  config/index.ts    — all tunable constants (durations→ticks, map size, HEX_SIZE, costs, palette); single source of truth
  game/              — simulation core (no render/ or ui/ imports)
    state.ts         — GameState, createInitialState, season derivation, SAVE_VERSION
    map.ts           — 40×40 pointy-top hex map + procedural gen + per-hex forest/mine state
    hex.ts           — hex geometry: 6-neighbour adjacency, distance, pixel↔hex math (single source of grid shape)
    rng.ts           — seeded PRNG (mulberry32)
    pathfinding.ts   — hand-written hex-grid A* (6-direction, uniform cost, hex-distance heuristic)
    units.ts         — unit kinds + order/task model (Order union)
    resources.ts     — resource types, trade values, pool/inventory helpers
    buildings.ts     — building kinds, storage, repair cost, nearest-storage lookup
    fields.ts        — farm + hay field tile features (ploughed/planted/grown, hayBuilding/hayMature)
    actions.ts       — order state machines (move/gather/field/build/operate) + placement/cost/housing helpers
    commands.ts      — Command union (the only input→sim channel)
    update.ts        — stateless step: commands→orders, advance units, advance buildings, grow crops
    persistence.ts   — JSON serialize/deserialize for save/load
  render/
    renderer.ts      — canvas drawing; reads state, never mutates it
    sprites.ts       — sprite loader (Kenney CC0 terrain/buildings + worker/soldier unit cells); best-effort, falls back to colour fill/circle
  ui/
    camera.ts        — camera/view state + screen↔tile transforms (not saved); View carries selection, placement ghost, hover
    controls.ts      — mouse/keyboard input, selection, command emission; builds the #action-panel DOM
    hud.ts           — HUD overlay (resource bar, storage, season/timer, population, equipment) + #unit-tooltip on hover
    hud.css          — HUD + layout styles
index.html           — canvas + HUD overlay shell; loads /src/main.ts
public/assets/sprites/ — terrain + building PNGs (Kenney CC0) and unit PNGs (worker, soldier)
test/                — Vitest headless simulation tests
e2e/                 — Playwright browser play-tests
```

### Coordinate System

The board is a **40×40 pointy-top hex grid** using **odd-r offset coordinates**:
a hex is `(col, row)`; odd rows shift half a hex-width right. `tiles[]` is
row-major like a square grid — only adjacency, distance, and pixel math differ.
All geometry lives in the pure module `src/game/hex.ts`:
`hexNeighbors`, `hexDistance`, `hexToPixel`/`pixelToHex` (fractional-aware for
smooth movement), `hexStep`. `HEX_SIZE = 40` (circumradius); footprint ≈ 69×80 px.

### Game Loop & Persistence

`requestAnimationFrame` drives render; a separate accumulator steps the sim at a
fixed 30 ticks/sec (`main.ts`). Pause freezes the tick accumulator, not rendering.
LocalStorage auto-save + manual save/load; one slot, JSON state, `SAVE_VERSION`
gate in `persistence.ts` (a mismatched version is rejected on load).

## Testing

Two layers matching the sim/render split (req §2.10):

- **Vitest sim tests** (`test/`) — pure headless `update()` exercises: gather
  rates, carry caps, farming lifecycle, construction/craft/train, save round-trips,
  deterministic ticking. This is where mechanics are verified. Fast (~700ms).
- **Playwright browser tests** (`e2e/`) — boot the real page and drive it through
  `window.__game` (dev-only hook: `getState`, `getView`, `enqueue`, `isPaused`,
  `tick(n)`). Keep thin: page boot, no console errors, HUD/input wiring, save/reload
  — not mechanics. `tick(n)` fast-forwards the sim so long actions finish instantly.

Run both with `npm run test:all`.

## Conventions

- Keep the sim pure: `game/` never imports from `render/`/`ui/`, never touches the
  DOM, never uses `Date.now()` or `Math.random()`. View state (camera, selection)
  lives in `ui/` and is never saved or fed to `update()`.
- New tunable values go in `config/index.ts`, not inline in logic.
- New input → add a `Command` variant, emit it from `controls.ts`, handle it in
  `update.ts`. Input never mutates state directly.
- Bump `SAVE_VERSION` when the serialized state shape changes.
- **Mining is a `gather` order** (resource `"ore"`), not an `operate` mode — the
  unit stands on a built Mine's mountain tile. `operate` is smithy/barracks only.

## Implementation Status (Milestones)

See req §27 for full milestone definitions and acceptance checks.

- **M1** ✅ — Map gen, hex rendering, camera, unit rendering + selection, pathfinding.
- **M2** ✅ — Worker gather loop (wood, farming lifecycle, fishing, mining), pooled
  storage, HUD, LocalStorage persistence.
- **M3** ✅ — Building system: placement, construction, all building types, smithy
  crafting (→ global equipment pool), barracks training (housing-gated), repair,
  demolish. Mining requires a built Mine; mine type rolled at completion.
- **Hex board** ✅ — 40×40 pointy-top hex grid; `SAVE_VERSION = 4`.
- **UI polish** ✅ — Unit hover tooltip; clickable action panel (Build always,
  Unit/Building sections by selection). Field actions (Plough/Plant/Harvest) use
  a building-style "pick action → click target cell" mode with a ghost preview.
- **M4** ⬜ — Season cycle, action durations, end-of-season upkeep/demotion,
  season-locked actions, crop loss, forest regrowth. *(Currently the calendar is
  derived from ticks and seasons advance, but upkeep, season-locks, and regrowth
  are not yet enforced; crops mature on a fixed timer placeholder.)*
- **M5** ⬜ — Soldiers/captains combat, equipment effects, horses, town economy.
- **M6** ⬜ — Enemy AI, end-of-year events (attack/tax/misc), event announcement.
- **M7** ⬜ — Intro + game-over screens, balancing pass, accessibility.

> v1 ships placeholder/CC0 graphics; final art is not provided (req §3.2). Gather
> rates, HEX_SIZE, and unit speed are tunable (`config/`) and get retuned in M7.

## Input & Color Reference

Keyboard/mouse bindings and the color palette are specified in req §20 and §3.1
and implemented in `controls.ts` / `config/index.ts` (`COLORS`). In short: digits
1–6 enter placement mode (House/Barn/Smithy/Barracks/Mine/Hay); F enters plough
mode (then click the target cell — Plant/Harvest are action-panel buttons); X/R
demolish/repair the selected building; K/L craft sword/shield; T trains; C cancels;
Space pauses; Esc cancels placement/field-mode/selection. Placement and field
modes are pick-then-click with a ghost preview; right-click also cancels them.
Every shortcut has an action-panel button.
