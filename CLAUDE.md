# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hamlet Havoc** is a single-player, browser-based real-time strategy game with a medieval/fantasy theme. Players manage a hamlet through a four-season yearly cycle, gathering resources, training units, building structures, and defending against end-of-year events.

## Running the Game

No build step required. Open `index.html` directly or serve via a local HTTP server (required for ES modules):

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Architecture

Pure client-side static files: `index.html`, JS modules, CSS, and assets. No backend, no npm, no bundler.

### Suggested Module Structure

```
main.js              — bootstrap, game loop (fixed 30 ticks/sec update + render)
game/
  gameState.js       — central state object (single source of truth)
  map.js             — 40×60 tile map, procedural generation
  units.js           — unit definitions and behavior
  buildings.js       — building definitions and construction
  actions.js         — action handling (plough, plant, mine, fish, chop, build)
  season.js          — season/year progression, upkeep at season end
  events.js          — end-of-year event system
  combat.js          — combat resolution (1 attack/sec, damage = roll(min,max) - defense)
  ai.js              — enemy pathfinding and targeting
ui/
  hud.js             — HUD elements (resource bar, season timer, event display)
  input.js           — mouse (click/drag-select/right-click) and keyboard handlers
render/
  renderer.js        — canvas drawing
  sprites.js         — sprite management
assets/              — sprites and tile graphics (placeholder hand-drawn style)
```

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
- **Misc**: See events table in `game/events.js` for the full library.

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
