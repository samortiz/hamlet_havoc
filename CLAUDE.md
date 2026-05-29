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
    state.ts         — GameState (units/buildings/fields/enemies/resources/equipment/town), createInitialState, season derivation, SAVE_VERSION
    map.ts           — 40×40 pointy-top hex map + procedural gen + per-hex forest/mine state + town placement
    hex.ts           — hex geometry: 6-neighbour adjacency, distance, pixel↔hex math (single source of grid shape)
    rng.ts           — seeded PRNG (mulberry32)
    pathfinding.ts   — hand-written hex-grid A* (6-direction, uniform cost, hex-distance heuristic)
    units.ts         — unit kinds + order/task model (Order union); equipment/horse/carry-cap helpers
    resources.ts     — resource types, trade values, pool/inventory helpers
    buildings.ts     — building kinds, storage, repair cost, nearest-storage lookup
    combat.ts        — enemy entities (goblin/serpent/kraken) + the §17.1 resolver (adjacency, roll−defense, horse absorption)
    fields.ts        — farm + hay field tile features (ploughed/planted/grown, hayBuilding/hayMature)
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
- **Mining is a `gather` order** (resource `"ore"`), not an `operate` mode — the
  unit stands on a built Mine's mountain tile. `operate` is smithy/barracks only.
- **Mountains are impassable until mined** (req §4.2, §13). `isWalkable` /
  `findPath` take an optional `buildings` arg: a mountain is walkable only when a
  *built* mine sits on it (no arg ⇒ every mountain blocked, used at map-gen). A
  mine is therefore built from an adjacent hex (`startBuild` falls back to
  `pathAdjacentTo` when the target tile isn't walkable), and the mountain opens up
  on completion. `findPath` permits an impassable *start* tile so a unit on a
  just-demolished mine isn't trapped.

## Implementation Status (Milestones)

See req §27 for full milestone definitions and acceptance checks.

- **M1** ✅ — Map gen, hex rendering, camera, unit rendering + selection, pathfinding.
- **M2** ✅ — Worker gather loop (wood, farming lifecycle, fishing, mining), pooled
  storage, HUD, LocalStorage persistence.
- **M3** ✅ — Building system: placement, construction, all building types, smithy
  crafting (→ global equipment pool), barracks training (housing-gated), repair,
  demolish. Interrupted builds can be resumed (right-click the site with workers,
  or select it + Resume) or demolished. Mining requires a built Mine; mine type
  rolled at completion. Mountains are impassable until their mine is built (§4.2,
  §13) — the mine is built from an adjacent hex and the mountain becomes walkable
  on completion.
- **Hex board** ✅ — 40×40 pointy-top hex grid; `SAVE_VERSION = 6`.
- **UI polish** ✅ — Unit hover tooltip; clickable action panel (Build always,
  Unit/Building sections by selection). Field actions (Plough/Plant/Harvest) use
  a building-style "pick action → click target cell" mode with a ghost preview.
- **M4** ✅ — Season cycle with HUD timer; end-of-season upkeep + demotion ladder
  (worker→dies, soldier→worker, captain→soldier; §6.3); season-locked actions
  (plant=spring, harvest=fall, summer/winter fishing-rate variance); crop loss for
  wheat unharvested by winter; forest stumps regrow at spring. Season boundaries
  are detected per-step from the tick count in `game/season.ts`; the ctx-mutating
  settlement (`processSeasonTransitions`) runs at the end of each `update()` step.
  Housing/population caps were already enforced at training time in M3.
- **M5** ✅ — Combat, town & horses (`SAVE_VERSION = 6`). One §17.1 combat
  resolver in `game/combat.ts` (`stepCombat`): hex-adjacent units/enemies trade
  blows once per second (`attackCooldown`), damage = `roll(attack range) −
  defence` clamped ≥0; a horse's buffer HP (`horseHp`) soaks damage first and
  dies when spent. Units gained `equipped` (sword +1 atk / shield +1 def, each
  eating a carry slot) and `horseHp` (×2 speed, +5 carry). New orders `attack`
  (close in, then the combat pass swings — idle soldiers/captains auto-attack
  adjacent enemies, workers defend in place) and `trade` (walk to the town tile,
  exchange at listed values; surplus returned as gold + hay change). New commands
  `attack`/`trade`/`equip` (equip is instant, pulling from the global equipment
  pool). The `town` tile is placed at gen time far from the Main Hall; `enemies`
  are id-keyed plain data — **stationary and injectable in M5; spawning, movement
  AI, and loot are M6.** Horse upkeep (2 hay-or-wheat/season) folds into the
  existing end-of-season pass. Combat resolves one swing per `update()` step, so
  real play (1 tick/step) is correct but `tick(n)` does *not* fast-forward an
  active fight — sim tests step combat tick-by-tick.
- **Town interface** ✅ (req §18, `SAVE_VERSION = 6`) — Interactive marketplace.
  `GameState.townStorage` is a resource pool kept *separate* from `resources`, so
  goods stashed at town don't count against the hamlet cap. When an idle unit is
  at (or next to) the town tile, `ui/town.ts` auto-opens a modal panel with four
  areas (For Sale / Cart / Town Storage / Carrying). Two instant commands drive
  it: `townStore` (free transfer between unit inventory and town storage, cap-
  clamped when loading the unit) and `townTrade` (buy a cart + optional horse,
  paying with goods offered from inventory and/or storage). The sim logic lives
  in `game/actions.ts`: `isUnitAtTown`, `executeTownStore`, `evaluateTownTrade`
  (pure — shared by the UI to enable/explain Confirm), and `executeTownTrade`.
  The shopkeeper accepts only when offered value ≥ cart value; surplus is returned
  to town storage as value-exact gold + hay change. The older automatic `trade`
  order (the "Sell at Town" / "Buy Horse" action-panel shortcuts) is unchanged;
  right-clicking the town tile now just walks the unit there so the panel opens.
- **Mountain types** ✅ (T2, `SAVE_VERSION = 7`) — every mountain tile gets a rock
  type (stone/iron/gold) rolled at map-gen (`map.mountainType`, `mountainTypeAt`;
  weights in config `MOUNTAIN_TYPE_WEIGHTS`). That type biases the mine type rolled
  when a Mine completes there (`MINE_TYPE_WEIGHTS_BY_MOUNTAIN`, replacing the old
  flat `MINE_TYPE_WEIGHTS`): stone→80/15/5, iron→40/50/10, gold→40/20/40. The
  renderer tags each mountain with a small rock-type dot near its peak and each
  built Mine with its rolled yield type. Old saves (no `mountainType`) fall back
  to "stone" via `mountainTypeAt`.
- **Main Hall worker production** ✅ (T5, `SAVE_VERSION = 8`) — the Main Hall can
  raise a fresh worker for free over `WORKER_SPAWN_TICKS` (20 s). `Building` gained
  `spawning`/`spawnProgress`; the `spawnWorker` command flips them on (gated by
  worker housing, §7.4). `advanceBuildings` ticks the Main Hall via `tickMainHall`,
  spawning the worker on a free adjacent tile on completion and stalling at the cap
  (smithy-style) if housing filled mid-production. The action panel shows a
  Create Worker button when a built Main Hall is selected; the renderer draws a
  progress bar under the hall while it works.
- **Upkeep notifications** ✅ (T7, `SAVE_VERSION = 9`) — the sim surfaces a
  player-facing event whenever upkeep is unpaid: a worker starving, a captain/
  soldier demoted, or a horse lost. `GameState.notifications` is a rolling log
  (`GameNotification {id, tick, kind, message}`, capped at `MAX_NOTIFICATIONS`);
  `actions.ts` `notify()` appends to `ctx.notifications` from `chargeUpkeep`/
  `demote`, and `update()` writes back the last N. The HUD (`hud.ts`
  `drainNotifications`) toasts each id once into the `#hud-notifications` stack,
  lazily initialising its high-water mark so a loaded save doesn't replay.
- **Farming polish** ✅ (T8) — planting now takes 10 s (`PLANT_TICKS`); a
  harvested wheat field yields a random `WHEAT_HARVEST_MIN..MAX` (10–20, seeded
  RNG) instead of a flat 4. Wheat fields green up as they grow: the renderer
  lerps a planted field's colour from the pale `fieldPlanted` toward the deep
  `fieldGrown` over `CROP_GROW_TICKS`. A worker left **idle on a wheat field**
  tends it hands-free — `autoFarmOrder` (in `advanceUnit`'s idle case) plants a
  ploughed field in spring (when seed wheat is on hand) and harvests a ripe one
  in fall.
- **Hall load/unload** ✅ (T9) — a load/unload interface mirroring the town
  marketplace, but transferring between a unit's inventory and the hamlet's
  shared `resources` pool (so it respects the storage cap). `ui/hall.ts` opens a
  modal (`#hall-panel`) when a *built storage building* (Main Hall, Barn, House)
  is selected with a non-captain unit on or beside it (`isUnitAtBuilding`,
  hex-distance ≤ 1) — prefers a unit in the current selection, else the lowest
  id. One instant command, `hallStore` (handled in `game/actions.ts`
  `executeHallStore`): `toStorage` true = unit → pool (clamped to free pool
  space), false = pool → unit (clamped to carry room). Lets the player unload a
  returning worker or load one up for a town run. Unlike the auto-opening town
  panel it is selection-driven, with Load/Store/Unload All/Close buttons; it
  reuses the `town-*` CSS. No new persisted state (`SAVE_VERSION` unchanged).
- **Building tooltip** ✅ (T10) — hovering a building shows a tooltip mirroring
  the unit one: name, `HP x/y`, and kind-specific stats (storage contribution,
  house/barracks housing, in-progress craft/train/worker-spawn %, a mine's rolled
  yield; under-construction shows build %). `controls.ts` tracks
  `hoveredBuildingId` (a hovered unit wins ties); `ui/hud.ts` `describeBuilding` +
  `updateBuildingTooltip` render `#building-tooltip` (shares the unit-tooltip CSS).
- **M6** ⬜ — Enemy AI + spawning
  **M7** ⬜ — End-of-year events (attack/tax/misc), event announcement.
- **M8** ⬜ — Intro + game-over screens, balancing pass, accessibility.

## Input & Color Reference

Keyboard/mouse bindings and the color palette are specified in req §20 and §3.1
and implemented in `controls.ts` / `config/index.ts` (`COLORS`). In short: digits
1–6 enter placement mode (House/Barn/Smithy/Barracks/Mine/Hay); F enters plough
mode (then click the target cell — Plant/Harvest are action-panel buttons); X/R
demolish/repair the selected building; K/L craft sword/shield; T trains; C cancels;
Space pauses; Esc cancels placement/field-mode/selection. Placement and field
modes are pick-then-click with a ghost preview; right-click also cancels them.
Every shortcut has an action-panel button. M5 adds mouse/button-only actions (no
new hotkeys): right-click an enemy → attack, right-click the town tile → walk
there (the marketplace panel auto-opens on arrival); the Unit action-panel
section carries Equip/Unequip Sword·Shield and the Sell at Town / Buy Horse quick
auto-trade shortcuts.
