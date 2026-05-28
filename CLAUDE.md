# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hamlet Havoc** is a single-player, browser-based real-time strategy game with a medieval/fantasy theme. Players manage a hamlet through a four-season yearly cycle, gathering resources, training units, building structures, and defending against end-of-year events.

## Running the Game

This is a **TypeScript + Vite** project during development. TypeScript, Vite, and Vitest are dev-only dependencies — they compile and bundle away (`npm run build`) to the **plain static HTML/JS/CSS** that actually ships (req §2.8). There are no runtime dependencies in the shipped output.

```bash
npm install        # one-time
npm run dev        # Vite dev server with HMR
npm run build      # type-check (tsc --noEmit) + production bundle to dist/
npm run preview    # serve the production build
npm test           # run the Vitest headless sim tests
npm run typecheck  # tsc --noEmit only
npm run test:e2e   # Playwright browser play-tests (boots Vite, drives Chrome)
npm run test:all   # Vitest + Playwright back-to-back
```

## Architecture

Client-side game authored in TypeScript modules under `src/`, bundled by Vite into static files for delivery. No backend. The simulation core (`game/`) is decoupled from rendering and input (req §2.6): it imports nothing from `render/` or `ui/`, holds no DOM/canvas references, and advances as a pure `update(state, commands, dtTicks) → state`. State is plain, id-based, JSON-serializable data; all randomness draws from a single seeded PRNG stored in state.

### Module Structure (actual)

```
src/
  main.ts            — bootstrap; fixed-timestep loop (30 ticks/sec) decoupled from render
  config/
    index.ts         — tunable constants (durations→ticks, map size, HEX_SIZE, palette); single source of truth (§2.6, §26)
  game/              — simulation core (imports nothing from render/ or ui/)
    state.ts         — central GameState, initial state, season derivation
    map.ts           — 40×40 pointy-top hex map + procedural generation + per-hex forest/mine state
    hex.ts           — hex geometry: 6-neighbor adjacency, hex distance, pixel↔hex math (single source of truth for grid shape)
    rng.ts           — seeded PRNG (mulberry32); state lives in GameState
    pathfinding.ts   — hand-written hex-grid A* (6-direction, uniform cost, hex-distance heuristic)
    units.ts         — unit definitions and order/task model
    resources.ts     — resource types, values, pool/inventory helpers
    buildings.ts     — building kinds, storage, nearest-storage lookup
    fields.ts        — farm field tile feature (ploughed/planted/grown)
    actions.ts       — order state machines (gather/farming) + helpers
    commands.ts      — command types (the only input→sim channel)
    update.ts        — stateless step: update(state, commands, dtTicks) → state
    persistence.ts   — JSON serialize/deserialize for save/load
  render/
    renderer.ts      — canvas drawing; reads state, never mutates it
  ui/
    camera.ts        — camera/view state + screen↔tile transforms (not saved); View includes hoveredUnitId + mouse screen coords
    controls.ts      — mouse/keyboard input, selection, command emission; manages #action-panel DOM (build/unit/building sections)
    hud.ts           — HUD overlay updates (reads state + view); manages #unit-tooltip on hover
    hud.css          — HUD + layout styles (tooltip, action panel, resource bar, etc.)
index.html           — canvas + HUD overlay shell; loads /src/main.ts
test/                — Vitest headless simulation tests
e2e/                 — Playwright browser play-tests (boots Vite, drives Chrome)
playwright.config.ts — Playwright config (headless system Chrome, port 5173)
```

### Testing

Two layers, matching the sim/render split (req §2.10):

- **Vitest sim tests** (`test/`) — pure headless `update(state, commands, dtTicks)` exercises. This is where mechanics live: gather rates, carry caps, farming lifecycle, save round-trips, deterministic ticking. Fast (~600ms for the suite).
- **Playwright browser tests** (`e2e/`) — boot the real page, drive it through `window.__game` (a dev-only sim hook exposing `getState`, `enqueue`, `tick`). Keep this layer thin: page loads, no console errors, HUD reflects state, input wiring, save/reload — not mechanics. The `tick(n)` seam fast-forwards the sim so a multi-minute gather cycle completes in milliseconds of real time.

Run both: `npm run test:all`.

> Seasons/upkeep, combat, enemy AI, and end-of-year events are still to come (M4–M6). M3's construction system (placement, all building types, smithy crafting, barracks training, repair, demolish) is implemented. Final art assets are not provided; v1 uses placeholder hand-drawn-style sprites (req §3.2).

### Rendering

- HTML5 `<canvas>` for game world; HUD as overlaid HTML/CSS elements.
- Target: 1280×720 baseline, scalable. 30–60 FPS target.
- Pointy-top hex tiles, `HEX_SIZE = 40` (circumradius). Per-hex footprint ≈ 69 wide × 80 tall px. Map: 40×40 hexes.
- V1 uses static sprites (no frame animation).

### Coordinate system

The board uses **odd-r offset coordinates**: a hex is named by `(col, row)` where odd rows are visually shifted half a hex-width to the right. `tiles[]` is row-major exactly like a square grid; only the adjacency, distance, and pixel-conversion math differ.

All geometry helpers live in `src/game/hex.ts` (a pure module, no render/ui dependencies):
- `hexNeighbors(x, y)` returns the 6 odd-r neighbors.
- `hexDistance(a, b)` is the cube-coordinate hex distance (drives the A* heuristic).
- `hexToPixel(x, y)` / `pixelToHex(px, py)` map between offset coordinates and world-pixel centers (supports fractional inputs for smooth unit interpolation).
- `hexStep(center, dirIdx, count)` walks N hops in one of the 6 cube directions (used for map-gen seeding).

### Game Loop

Fixed-timestep logic (30 updates/sec) decoupled from render. `requestAnimationFrame` drives render; a separate accumulator drives game ticks.

### Persistence

LocalStorage auto-save and manual save. JSON-serialized game state. No save slots in v1.

---

## Key Game Rules (Implementation Reference)

### Seasons & Time
- Season duration: **60 real seconds** (configurable constant — will need tuning).
- Order: Spring → Summer → Fall → Winter → end-of-year event → Spring (year++)
- Upkeep collected **at end of each season**.
- Upkeep failure: workers die; soldiers demote to worker; captains demote to soldier.

### Units
| Unit        | Att  | Def | HP | Carry | Upkeep      |
|-------------|------|-----|----|-------|-------------|
| Worker      | 0–2  | 0   | 2  | 5     | 1 food (wheat or meat) |
| Soldier     | 1–3  | 0   | 4  | 5     | 1 meat      |
| Captain     | 1–5  | 1   | 6  | —     | 1 gold      |

- Any unit can equip Sword (+1 Att) or Shield (+1 Def); equipment occupies carry slots.
- Captains carry only equipment, no resources.
- Combat: 1 attack/sec. Damage = random(min, max) − defender.defense. Min damage = 0.
- Any unit can have a horse: +3 HP (horse absorbs first 3 damage), ×2 speed, +5 carry. Upkeep: 2 hay or 2 wheat/season.
- Base movement speed: **2 tiles/sec** (tunable, see §26); horse doubles it.

### Buildings
- Placed on grass (except Mines on mountain tiles; ploughed fields and hay fields on grass).
- Storage is pooled globally (Main Hall=20, House=10, Barn=50). Storage from under-construction buildings doesn't count toward the cap until they finish.
- Construction times (req §7 table): House 20s · Barn 30s · Smithy 60s · Barracks 60s · Mine 30s · Hay Field 30s · Plough 20s. Multiple builders on the same site stack progress linearly.
- Construction cost is deducted on placement, not on completion — demolish refunds nothing.
- Mine tile type (stone/iron/gold) is rolled by the seeded RNG at construction completion (req §13.1).
- Any worker can operate any building (smithy, barracks). One operator at a time per building; re-issuing `craft` to the same operator lets them switch item.
- Smithy item production: 1 season per item (Sword: 2 Iron; Shield: 2 Iron + 2 Wood). Items go into a global equipment pool; equipping onto a unit lands in M5.
- Barracks training: Worker→Soldier or Soldier→Captain = 1 season; gated by barracks housing (§7.4). Promoted unit gets the new kind's max HP and emerges at the barracks tile.
- Buildings can be repaired (HP restored over time at the build-cost rate; cost scales with HP missing) and demolished by the player. The Main Hall can't be demolished (it's a loss condition).

### Input (M3 additions)
- Digits 1–6 enter placement mode for House / Barn / Smithy / Barracks / Mine / Hay Field. Left-click places the building (one-shot); Esc or right-click cancels placement.
- F (with a selected unit): if hovering a valid grass tile, ploughs it immediately; otherwise toggles pending-plough mode (next left-click on a grass tile sends the plough command).
- Click a building tile to select that building (no drag-select for buildings).
- X: demolish the selected building.
- R: repair the selected building with the selected workers.
- K / L: with a smithy selected and a worker selected, craft Sword / Shield.
- T: train selected unit at the selected barracks (inferred from kind: worker→soldier, soldier→captain).
- C: cancel current order on selected units (used to pull a smithy operator out, etc.).

### Action Panel & Tooltip (UI additions)
- **Action panel** (bottom-left, `#action-panel`): replaces the old static keyboard-legend build menu. Built and managed by `controls.ts` — rebuilt whenever selection changes. Always shows a **Build** section with clickable buttons (mirrors digit keys 1–6). Shows a **Unit** section (Cancel, Plough buttons) when units are selected. Shows a **Building** section (Demolish, Repair, Craft Sword/Shield, Train) when a building is selected; available actions depend on building kind and whether workers are also selected.
- **Unit tooltip** (`#unit-tooltip`): appears when hovering over a unit on the canvas. Shows kind, HP / max HP, current order description, and carrying inventory. Managed by `hud.ts`; positioned near the cursor, flipping left/up to avoid viewport clipping. Hidden when the mouse leaves the canvas or hovers empty terrain.

### Resource Gathering
- **Wood**: 1 wood/5 sec from forest tile; carry cap 5; forest depletes after 5 wood (becomes stump, regrows at Spring start).
- **Fishing**: 1 meat/5 sec base (seasonal variance lands in M4 per req §14). Worker or soldier on hex adjacent to water.
- **Mining**: Worker or soldier inside a mine; 1 yield/5 sec. Mine type assigned at build: Stone (50%), Iron (40%), Gold (10%). Gold mine: 10% chance diamond per yield. Iron/gold mines: 15% goblin spawn chance per mining interval (M3+).
- **Farming**: Plough (any season, 20 sec) → Plant spring only (costs 1 wheat/tile, 20 sec) → grows summer → Harvest fall (20 sec). Unharvested crops lost at end of fall.
- **Hay fields**: No ploughing needed; cost 2 wood; produce continuously each year without replanting.

> Gather rates and unit speed are tuned values exposed in `src/config/index.ts`; they will be retuned during M7 balancing.

### Combat & Enemies
- Enemies target nearest building or unit; goblins from mines target the miner first.
- Sea serpents and krakens only attack units that are fishing (water-adjacent); they stay until winter ends.
- Year-end attack: enemies spawn from a random map edge.
- Loss conditions: Main Hall destroyed OR all workers dead.

### End-of-Year Events
- Announced at year start (type only; magnitude hidden until event triggers).
- **Attack**: Enemies scale in count/type based on hamlet metrics (population, buildings, etc.).
- **Tax**: Demanded in gold; shortfall paid at double rate in other resources (player selects); remaining shortfall destroys buildings (player selects which).
- **Misc**: See events table in `game/events.ts` for the full library.

### Town
- A fixed location on the map edge (far from Main Hall). Units walk there carrying goods.
- Can buy/sell all basic resources and purchase horses (cost = 20 resource value).

### Input
- Left click: select unit / UI element (or confirm placement/plough in pending mode). Drag: box-select. Right-click: move or action target.
- Arrow keys / WASD: camera pan. Edge-scroll also supported.
- Space: pause. Escape: cancel action/placement/pending-plough/close menu.
- No number-key control groups in v1.
- All keyboard shortcuts have clickable equivalents in the action panel; both work simultaneously.

### Color Palette
- Greens: `#4a5d3a`, `#6b7d4f`. Browns: `#5c4a35`, `#8b7355`.
- Gold accents: `#c9a96e`, `#d4af37`. UI text: `#e8dcc4` (cream/parchment).

---

## Development Milestones

1. **M1** ✅ — Canvas, tile rendering, map gen, camera, unit rendering + selection.
2. **M2** ✅ — Worker resource loop (wood, farming lifecycle, fishing, mining), storage, HUD, persistence.
3. **M3** ✅ — Building system (placement, construction, all types, smithy crafting, barracks training, repair, demolish). Mining now requires a built mine.
3.5 **Hex board** ✅ — Square 40×60 grid replaced with a 40×40 pointy-top hex grid. 6-neighbor adjacency, hex A*, SAVE_VERSION = 4.
3.6 **UI polish** ✅ — Unit tooltip on hover (kind, HP, order, carrying). Clickable action panel replaces static keyboard-legend: Build section (always), Unit section (when unit selected), Building section (when building selected). Pending-plough mode added alongside F-key plough.
4. **M4** — Season cycle, action durations, upkeep, season-locked actions.
5. **M5** — Soldiers, captains, enemy AI, equipment.
6. **M6** — End-of-year event system (attack, tax, misc), event announcement.
7. **M7** — Game-over screen, balancing, intro screen.
