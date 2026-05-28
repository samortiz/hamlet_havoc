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
```

## Architecture

Client-side game authored in TypeScript modules under `src/`, bundled by Vite into static files for delivery. No backend. The simulation core (`game/`) is decoupled from rendering and input (req §2.6): it imports nothing from `render/` or `ui/`, holds no DOM/canvas references, and advances as a pure `update(state, commands, dtTicks) → state`. State is plain, id-based, JSON-serializable data; all randomness draws from a single seeded PRNG stored in state.

### Module Structure (actual)

```
src/
  main.ts            — bootstrap; fixed-timestep loop (30 ticks/sec) decoupled from render
  config/
    index.ts         — tunable constants (durations→ticks, map size, palette); single source of truth (§2.6, §26)
  game/              — simulation core (imports nothing from render/ or ui/)
    state.ts         — central GameState, initial state, season derivation
    map.ts           — 40×60 tile map + procedural generation + per-tile forest/mine state
    rng.ts           — seeded PRNG (mulberry32); state lives in GameState
    pathfinding.ts   — hand-written grid A* on walkable tiles
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
    camera.ts        — camera/view state + screen↔tile transforms (not saved)
    controls.ts      — mouse/keyboard input, selection, command emission
    hud.ts           — HUD overlay updates (reads state)
    hud.css          — HUD + layout styles
index.html           — canvas + HUD overlay shell; loads /src/main.ts
test/                — Vitest headless simulation tests
```

> Seasons/upkeep, combat, enemy AI, the full construction system, and end-of-year events are still to come (M3–M6). Final art assets are not provided; v1 uses placeholder hand-drawn-style sprites (req §3.2).

### Rendering

- HTML5 `<canvas>` for game world; HUD as overlaid HTML/CSS elements.
- Target: 1280×720 baseline, scalable. 30–60 FPS target.
- Tile size: 32×32 px. Map: 40×60 tiles.
- V1 uses static sprites (no frame animation).

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

### Buildings
- Placed on grass (except Mines on mountain tiles; ploughed fields and hay fields on grass).
- Storage is pooled globally (Main Hall=20, House=10, Barn=50).
- Any worker can operate any building (smithy, barracks).
- Smithy item production: 1 season per item (Sword: 2 Iron; Shield: 2 Iron + 2 Wood).
- Barracks training: Worker→Soldier or Soldier→Captain = 1 season; unit pays new upkeep immediately.
- Buildings can be repaired (same materials as construction) and demolished by the player.

### Resource Gathering
- **Wood**: 1 wood/15 sec from forest tile; carry cap 5; forest depletes after 5 wood (becomes stump, regrows at Spring start).
- **Fishing**: 1 meat/15 sec (Spring/Fall), 1/10 sec (Summer), 1/30 sec (Winter). Worker or soldier on tile adjacent to water.
- **Mining**: Worker or soldier inside a mine. Mine type assigned at build: Stone (50%), Iron (40%), Gold (10%). Gold mine: 10% chance diamond per yield. Iron/gold mines: 15% goblin spawn chance per 20-sec interval.
- **Farming**: Plough (any season, 20 sec) → Plant spring only (costs 1 wheat/tile, 20 sec) → grows summer → Harvest fall (20 sec). Unharvested crops lost at end of fall.
- **Hay fields**: No ploughing needed; cost 2 wood; produce continuously each year without replanting.

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
- Left click: select unit / UI element. Drag: box-select. Right-click: move or action target.
- Arrow keys / WASD: camera pan. Edge-scroll also supported.
- Space: pause. Escape: cancel action/close menu.
- No number-key control groups in v1.

### Color Palette
- Greens: `#4a5d3a`, `#6b7d4f`. Browns: `#5c4a35`, `#8b7355`.
- Gold accents: `#c9a96e`, `#d4af37`. UI text: `#e8dcc4` (cream/parchment).

---

## Development Milestones

1. **M1** — Canvas, tile rendering, map gen, camera, unit rendering + selection.
2. **M2** — Worker resource loop (wood, farming lifecycle, fishing, mining), storage, HUD.
3. **M3** — Building system (construction, all types, smithy, barracks).
4. **M4** — Season cycle, action durations, upkeep, season-locked actions.
5. **M5** — Soldiers, captains, enemy AI, equipment.
6. **M6** — End-of-year event system (attack, tax, misc), event announcement.
7. **M7** — Save/load, game-over screen, balancing, intro screen.
