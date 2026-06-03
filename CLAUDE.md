# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**Hamlet Havoc** is a single-player, browser-based real-time strategy game with a
medieval/fantasy theme. The player manages a hamlet through a four-season yearly
cycle: gathering resources, training units, constructing buildings, and defending
against end-of-year events.

**The full game design is in [`docs/hamlet_havoc_req.md`](docs/hamlet_havoc_req.md)** —
that document is the single source of truth for game rules and stat tables.
Section references like "§7.2" throughout the code point to it.
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

### Image Tooling

Two image-processing tools are installed for sprite work (cropping atlases from
`docs/raw_sprites/`, building animation strips, inspecting PNG content/bounding
boxes before they land in `public/assets/sprites/`):

- **ImageMagick 6.9** — invoked as `convert` (and `mogrify` / `identify`) at
  `/usr/bin/convert`. Note this is ImageMagick **6**, so there is **no unified
  `magick` command** (that's v7); always use `convert`, not `magick`.
- **Pillow (PIL) 10.2** — `import PIL` under `/usr/bin/python3`
  (`/usr/lib/python3/dist-packages/PIL`). Preferred for precise per-frame work:
  bounding boxes (`Image.getbbox()`), grid slicing, and Lanczos rescaling. The
  worker walk strip was built this way (see `src/render/sprites.ts`).

## Architecture

Client-side game in TypeScript under `src/`, bundled by Vite into static files.
No backend. The core invariant (req §2.6) is a **strict sim/render/input split**:

- `game/` — the simulation core. Imports nothing from `render/` or `ui/`, holds
  no DOM/canvas references, advances as a pure `update(state, commands, dtTicks) → state`.
- State is plain, **id-based, JSON-serializable** data (no class instances, no
  cross-entity object references — relationships are integer ids).
- All randomness draws from a **single seeded PRNG** whose state lives in
  `GameState`. Never call `Math.random()` in the sim.
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
    state.ts         — GameState (units/buildings/fields/enemies/resources/equipment/town), createInitialState, season derivation, SAVE_VERSION
    map.ts           — 40×40 pointy-top hex map + procedural gen + per-hex forest/mine state + town placement
    hex.ts           — hex geometry: 6-neighbour adjacency, distance, pixel↔hex math (single source of grid shape)
    rng.ts           — seeded PRNG (mulberry32)
    pathfinding.ts   — hand-written hex-grid A* (6-direction, uniform cost, hex-distance heuristic)
    units.ts         — unit kinds + order/task model (Order union); equipment/horse/carry-cap helpers
    resources.ts     — resource types, trade values, pool/inventory helpers
    buildings.ts     — building kinds, storage, repair cost, nearest-storage lookup
    combat.ts        — enemy entities (goblin/serpent/kraken) + the §17.1 resolver (adjacency, roll−defense, horse absorption)
    fields.ts        — farm + stables tile features (ploughed/planted/grown, stablesBuilding/stablesMature)
    actions.ts       — order state machines (move/gather/field/build/operate/attack/trade) + placement/cost/housing/trade helpers
    commands.ts      — Command union (the only input→sim channel)
    update.ts        — stateless step: commands→orders, advance units, advance buildings, resolve combat, grow crops
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
- **Never reference `docs/TODO.txt` or its `T<n>` task numbers from code, comments,
  or test names.** Those numbers are a transient planning device that lives only in
  `docs/TODO.txt`. The single source of truth for behaviour is the requirements doc —
  cite it by section (e.g. `§7.2`) instead.
- **When a TODO item changes the game's rules, update `docs/hamlet_havoc_req.md` in
  the same change.** The req doc must always reflect the current design; never let a
  TODO item be the only record of a requirement change.
- **Mining is a `gather` order** (resource `"ore"`), not an `operate` mode — the
  unit stands on a built Mine's mountain tile. `operate` is smithy/barracks only.
- **Mountains are impassable until mined** (req §4.2, §13). `isWalkable` /
  `findPath` take an optional `buildings` arg: a mountain is walkable only when a
  *built* mine sits on it (no arg ⇒ every mountain blocked, used at map-gen). A
  mine is therefore built from an adjacent hex (`startBuild` falls back to
  `pathAdjacentTo` when the target tile isn't walkable), and the mountain opens up
  on completion. `findPath` permits an impassable *start* tile so a unit on a
  just-demolished mine isn't trapped.


## Input & Color Reference

Keyboard/mouse bindings and the color palette are specified in req §20 and §3.1
and implemented in `controls.ts` / `config/index.ts` (`COLORS`). In short: digits
1–6 enter placement mode (House/Barn/Smithy/Barracks/Mine/Stables); F enters plough
mode (then click the target cell — Plant/Harvest are action-panel buttons); X/R
demolish/repair the selected building; K/L craft sword/shield; T trains; C cancels;
Space pauses; Esc cancels placement/field-mode/selection. Placement and field
modes are pick-then-click with a ghost preview; right-click also cancels them.
Every shortcut has an action-panel button. There are also mouse/button-only actions (no
hotkey): right-click an enemy → attack, right-click the town tile → walk
there (the marketplace panel auto-opens on arrival); the Unit action-panel
section carries Equip/Unequip Sword·Shield and the Sell at Town / Buy Horse quick
auto-trade shortcuts.
