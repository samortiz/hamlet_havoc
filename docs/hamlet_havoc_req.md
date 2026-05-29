# Hamlet Havoc — Detailed Requirements

## 1. Overview

**Hamlet Havoc** is a single-player, browser-based, real-time strategy game with a medieval/fantasy theme. The player manages a small hamlet, gathering resources, training units, constructing buildings, and defending against periodic end-of-year events across a four-season yearly cycle.


## 2. Technical Architecture

### 2.1 Platform
- Pure client-side browser game; no backend server required for core gameplay.
- Delivered as static files: `index.html`, JavaScript module(s), CSS, and asset files (sprites, audio if applicable).
- No build step required to play; the game must load by opening `index.html` (a simple HTTP server may be needed for module loading depending on chosen approach).

### 2.2 Rendering
- HTML5 `<canvas>` element used for all 2D rendering of the game world.
- The HUD is implemented as **overlaid HTML/CSS elements** positioned above the canvas. This was chosen over a canvas-drawn HUD because HTML/CSS gives easier text layout, native tooltips/hover, and better accessibility, while keeping the canvas focused on the game world.
- Target resolution: 1280×720 baseline, scalable to fit window.
- Target frame rate: 30–60 FPS.
- No minimap.
- The board is a **pointy-top hexagonal grid** (req §4.1). Pixel↔hex math lives in `src/game/hex.ts`.

### 2.3 Code Structure (suggested)
- `main.js` — bootstrap, game loop
- `game/` — core systems
  - `gameState.js` — central state object
  - `map.js` — map generation, tile data
  - `units.js` — unit definitions and behavior
  - `buildings.js` — building definitions
  - `actions.js` — action handling (plough, plant, mine, etc.)
  - `season.js` — season/year progression
  - `events.js` — end-of-year events
  - `combat.js` — combat resolution
  - `ai.js` — enemy unit behavior
- `ui/` — HUD, menus, input handling
- `render/` — canvas drawing, sprite management
- `assets/` — sprites, tile graphics

### 2.4 Game Loop
- Fixed-timestep update loop (e.g., 30 logical updates/second) decoupled from render loop.
- Game time is real-time but distinct from wall-clock time. A "season" maps to a configurable real-time duration (see §15.2).

### 2.5 Persistence
- LocalStorage used to save game state between sessions (auto-save and manual save/load).
- Save format: JSON serialization of the central game state.
- Named save slots are out of scope for v1 (single auto-save + manual save), but may be added later.

### 2.6 Simulation Architecture
- **Separation of concerns:** the simulation core (`game/`) imports nothing from `render/` or `ui/`, holds no canvas/DOM references, and advances purely as `update(state, commands, dtTicks) → state`. Rendering reads state; input emits commands. This separation is what makes save/load, pause, determinism, and headless testing possible, and is expensive to introduce later.
- **Plain-data, id-based state:** all entities (units, buildings, mines, fields, enemies) are plain serializable objects keyed by integer id. Relationships are stored as ids (e.g., `unit.insideBuildingId`, `building.occupantId`), never as object references — this keeps the whole state `JSON.stringify`-able with no circular references.
- **Stateless systems:** game logic lives in stateless system functions (movement, gathering, combat, season, events) that take and return state. Behavior is not attached to entity objects.
- **Data-driven config:** the stat tables in this document (units §6.1, buildings §7, resources §8, smithy items §7.2, actions §10, events §16) are the single source of truth and should be codified as plain config data the simulation reads — not numbers hardcoded across logic. This is what makes the tunable values in §26 a one-file change.
- **Seeded RNG:** all randomness (map generation, attack/damage rolls, mine type, goblin spawns, diamond chance, event selection/magnitude) draws from a single seeded PRNG whose seed and state live in the saved game. This gives reproducible runs, testable combat math, and save/loads that do not diverge. Never call `Math.random()` in the simulation.

### 2.7 Time Model
- **Ticks are the only time unit.** The simulation advances in fixed logical ticks (30/sec). All durations in this document expressed in seconds are converted to ticks once (e.g., a 60-sec season = 1800 ticks; 1 wood / 15 sec ≈ 1 wood / 450 ticks).
- `tickCount` is stored in state; the season timer, action progress, and upkeep are all derived from tick counts — **never from `Date.now()`/wall-clock** — so pause and save/load behave correctly.
- Pause freezes the tick accumulator; rendering may continue.

### 2.8 Tooling & Libraries
- **Language:** TypeScript — the state here (tagged unions of unit/building/event types) is exactly what static types catch early.
- **Dev/build:** Vite (dev server + HMR + production bundle) and Vitest for tests.
- **Rendering:** vanilla Canvas2D (no rendering dependency). PixiJS is an escape hatch only if profiling shows a need for WebGL sprite batching.
- **Pathfinding:** a small hand-written grid A\* (~100 lines), avoiding a dependency.
- **Runtime vs. dev dependencies:** the "no external runtime dependencies" rule (§24) refers to what ships. TypeScript, Vite, and Vitest are dev dependencies that compile/bundle away to the plain static files that are delivered, so they do not violate it.

### 2.9 Rendering Performance
To meet the ≥30 FPS target (§24) on a 40×40 hex grid:
- Render the static terrain layer **once to an offscreen canvas** and blit it per frame, redrawing only when terrain changes (forest cleared, building placed/destroyed).
- **Cull to the visible viewport** — only draw hexes/entities within the camera bounds (sample the viewport corners via `pixelToHex` to derive a hex range).
- Load all sprites from a **single texture atlas**, with a **preload step** before the intro screen (supports the 5-second load NFR).

### 2.10 Testing
Two layers, matching the sim/render split:
- **Headless sim tests (Vitest, `test/`)** — advance the sim for N ticks with scripted commands and assert on state. This is where mechanics live: combat math, upkeep/demotion, farming lifecycle, tax resolution, save → load → equality round-trips, deterministic ticking. The simulation core is fully exercisable here with no canvas/DOM.
- **Browser play-tests (Playwright, `e2e/`)** — drive the real page in headless Chrome to cover what the headless sim tests cannot: rendering, input wiring, HUD updates, save/reload, console-error-free boot. The page exposes a dev-only `window.__game` hook (`getState`, `enqueue(command)`, `tick(n)`) so tests can fast-forward multi-minute sim cycles in milliseconds. Keep this layer thin — mechanics belong in the sim tests; the e2e suite asserts only that the wiring around the sim is intact.
- Run scripts: `npm test` (sim), `npm run test:e2e` (browser), `npm run test:all` (both).

---

## 3. Visual Style

### 3.1 Color Palette
- Primary palette: muted greens (#4a5d3a, #6b7d4f) and browns (#5c4a35, #8b7355).
- Accent: gold (#c9a96e, #d4af37) used for highlights, HUD borders, and currency icons.
- UI text: cream/parchment (#e8dcc4) on dark backgrounds.

### 3.2 Graphics
- Sprite-based 2D graphics for all units, buildings, and terrain tiles.
- **Placeholder, hand-drawn-style graphics for v1** — final art assets are not provided.
- Tiles are pointy-top hexes with circumradius `HEX_SIZE = 20` px (per-hex footprint ≈ 35 wide × 40 tall).
- Each unit has at least: an idle sprite and an action sprite (working/fighting).
- **v1 uses static sprites** — unit movement is position change only; frame-based animation is deferred to a future update.

---

## 4. Map

### 4.1 Generation
- Procedurally generated each new game using hex-based generation.
- Default map size: **40 × 40 hexes** (pointy-top, odd-r offset coordinates).
- Map is bounded; no scrolling beyond edges.
- "Adjacent" throughout this document means **hex-adjacent** — one of the 6 neighbors on the odd-r grid, at hex-distance 1.

### 4.2 Tile Types
| Tile     | Walkable | Activities                          | Buildable On |
|----------|----------|-------------------------------------|--------------|
| Grass    | Yes      | Build farm, place buildings         | Yes          |
| Forest   | Yes      | Collect wood                        | After clearing |
| Water    | No       | Fish (from adjacent tile)           | No           |
| Mountain | When mined | Build a mine (from an adjacent tile) | Mine only  |

- Mountains are **impassable** until a mine is built on them. The mine is built by a worker standing on an adjacent tile; once the mine completes, the mountain becomes walkable so units can stand on it to mine. A mountain blob's interior tiles (no walkable neighbour) therefore cannot host a mine.
- Forest tiles can be **cleared to grass**: after the wood is harvested the tile becomes a stump and then bare grass, which is buildable.
- Cleared/stumped forest regrows at the start of spring (see §12).

### 4.3 Generation Constraints
- The starting hamlet must spawn on contiguous grass tiles large enough to fit the initial buildings plus open space.
- The map should contain a minimum of each terrain type (e.g., ≥10% forest, ≥5% water, ≥5% mountain).
- Resources should be distributed so the player has reasonable access to all gathering activities from the starting position.

### 4.4 Camera / Viewport
- Camera scrolls if the map exceeds the visible area. Camera control is **keyboard panning (arrow keys / WASD) and mouse edge-scroll only** — clicking and dragging are reserved exclusively for selecting/commanding units and interacting with menus.

---

## 5. Starting Conditions

A new game initializes with:
- 1 Main Hall (provides central storage and acts as drop-off point)
- 2 Worker Houses (housing 4 workers total)
- 4 Workers
- 4 Wheat (in storage)
- Procedurally generated surrounding terrain
- Season: Spring, Year 1, Day 1

---

## 6. Units

### 6.1 Stats Table
| Unit        | Attack | Defense | HP | Carry Cap | Upkeep / season | Notes                                                       |
|-------------|--------|---------|----|-----------|-----------------|-------------------------------------------------------------|
| Worker      | 0–2    | 0       | 2  | 5         | 1 food          | Plant, harvest wood, fish, mine, build                      |
| Soldier     | 1–3    | 0       | 4  | 5         | 1 meat          | Fish, mine; **cannot** plant or chop wood                   |
| Captain     | 1–5    | 1       | 6  | 2†        | 1 gold          | Carries only equipment (sword/shield); no resources         |
| Goblin      | 0–3    | 0       | 3  | —         | —               | Enemy; drops Iron, occasionally Gold                        |
| Sea Serpent | 0–2    | 0       | 3  | —         | —               | Enemy; drops Meat, occasionally Gold                        |
| Kraken      | 1–3    | 1       | 5  | —         | —               | Enemy; drops Meat/Gold, rarely Diamond                      |

### 6.2 Attack Notes
- Attack is expressed as a range with minimum and maximum damage (e.g., 0–2 means damage rolls between 0 and 2 inclusive per attack).
- "Food" for a worker means any food resource (wheat or meat) — they are interchangeable.
- Defense reduces incoming damage by the defense value

### 6.3 Upkeep
- Upkeep is consumed at the **end of each season**.
- **If upkeep cannot be paid, the unit is demoted rather than simply lost:**
  - Worker → dies (removed from the game).
  - Soldier (not fed meat) → demoted to Worker.
  - Captain (not paid gold) → demoted to Soldier.
- Only Workers are permanently lost to unpaid upkeep; higher tiers fall back one rank.

### 6.4 Equipment
- Captains, Soldiers and Workers can equip:
  - **Sword**: +1 Attack
  - **Shield**: +1 Defense
- A unit may equip at most **one sword and one shield**.
- Equipping is handled via UI. **Each equipped sword or shield occupies one carry slot** (counts as one carried item): for a Worker or Soldier (carry cap 5), equipping both leaves 3 slots for resources.
- **†** Captains carry no resources, but have a dedicated 2-slot capacity used only for equipment (one sword + one shield). 

### 6.5 Selection, Movement & Orders
- Player selects unit(s) by clicking (single) or drag-box (multiple).
- **Base movement speed: 2 tiles/second** (tunable — see §26); a horse doubles it.
- Movement uses pathfinding (6-direction hex A\* with uniform per-hop cost and a hex-distance heuristic) on the walkable hex grid. **Walkability is dynamic:** clearing forest, placing/destroying a building, and building a mine all change which hexes are passable, so paths recompute when the grid changes. Buildings occupy and block their hex.
- **Orders (unit task model):** each unit holds a current order with a target and runs a small state machine. Orders: `Move`, `Gather` (wood/fish/mine), `Build`, `Plough`, `Plant`, `Harvest`, `Train`, `Trade`, `Attack`, `Idle`. A gather/build order cycles through sub-states (move-to-target → work → when full, move-to-storage → deposit → repeat) and continues until interrupted, the target is exhausted/invalid, or a season lock makes it invalid.
- **Right-click target resolution** (context-sensitive): empty walkable tile → Move; a work target (forest, water-adjacent tile, mine, ploughable/plantable/harvestable tile, construction site) → the matching work order if the unit's type permits it; enemy unit → Attack; own smithy/barracks → enter to operate/train.
- **Auto-attack:** idle soldiers and captains automatically attack an adjacent enemy; workers defend if attacked but do not seek out enemies. A unit on an explicit order does not break off to chase enemies unless ordered.

---

## 7. Buildings

| Building       | Cost                       | HP  | Build Time | Storage | Effect                              |
|----------------|----------------------------|-----|------------|---------|-------------------------------------|
| Main Hall      | (pre-built; not buildable) | 100 | N/A        | 20      | Central resource drop-off           |
| House          | 3 Wood + 2 Wheat           | 50  | 20 sec     | 10      | Houses 2 workers                    |
| Barn           | 5 Wood                     | 60  | 30 sec     | 50      | Additional storage                  |
| Smithy         | 3 Stone + 3 Wood           | 80  | 60 sec     | —       | Crafts weapons and armor            |
| Barracks       | 3 Stone + 4 Wood + 2 Iron  | 80  | 60 sec     | —       | Trains & houses soldiers/captains   |
| Mine           | 4 Wood                     | 50  | 30 sec     | —       | Required to mine a mountain tile    |
| Ploughed Field | — (1 Wheat to plant)       | 5   | 20 sec     | —       | Tile feature; can be planted        |
| Hay Field      | 2 Wood (fencing)           | 5   | 30 sec     | —       | Tile feature; produces hay          |

> Building HP values fall in the 50–100 range per the design decision; the specific per-building numbers above are a proposal and may be tuned during balancing (see §26). Ploughed/hay fields are flimsy tile features, not structures, so they keep low HP.

### 7.1 Building Rules
- All buildings except the Mine and Farm must be placed on grass.
- Mines must be placed on mountain tiles.
- Farms (which are a tile-based feature rather than a structure) require ploughed grass.
- Hay fields are placed on grass and require only a wood fencing cost (no ploughing).
- Storage values represent how much that building adds to the total storage limit. The storage limit is the sum of all buildings + Main Hall, and storage is a **single pooled total** shown in the HUD.
- A building under construction is displayed as a partially built sprite until completed.
- Buildings have HP and can be destroyed in attacks.
- **Repair:** Damaged buildings can be repaired using the same materials they were built with (cost scales with the HP missing).
- **Demolish:** The player can demolish any building to reclaim the space; demolished buildings do not refund their cost.
- **No maximum** number of any building type.
- Any worker can operate any building (smithy, barracks, mine) by stepping inside — buildings do not require a permanently assigned worker.

### 7.2 Smithy Items
| Item    | Cost            | Effect    |
|---------|-----------------|-----------|
| Sword   | 2 Iron          | +1 Attack |
| Shield  | 2 Iron + 2 Wood | +1 Defense|

- Any worker stationed inside the smithy produces items; **each item takes 1 season** to craft.

### 7.3 Barracks Training
- Worker → Soldier: 1 season
- Soldier → Captain: 1 season
- During training, the unit is unavailable for other tasks and remains in/near the barracks.
- Training has **no extra resource cost** beyond upkeep: when starting training the unit must pay the new (higher) upkeep cost.

### 7.4 Housing & Population
- **Workers** are housed by Houses (2 per House). **Soldiers and Captains** are housed by Barracks (capacity per Barracks is tunable — default 4; see §26). The Main Hall provides no housing.
- The population cap for each category is the sum of the relevant housing. A unit cannot be created or trained into a category that has no free housing slot.
- Training moves a unit between categories and therefore between housing pools: a Worker → Soldier frees a House slot and consumes a Barracks slot. Training cannot start unless a free destination slot exists.
- The HUD population display shows current count vs. capacity per category.

---

## 8. Resources

| Resource | Value | Use                                                    |
|----------|-------|--------------------------------------------------------|
| Hay      | 1     | Food for horses                                        |
| Wheat    | 2     | Food for workers; also seed for planting               |
| Wood     | 3     | Building construction                                  |
| Stone    | 4     | Building construction                                  |
| Meat     | 5     | Food for workers, soldiers, captains                   |
| Iron     | 5     | Weapons, armor, barracks construction                  |
| Gold     | 10    | Town purchases, captain pay, taxes                     |
| Diamond  | 50    | Same uses as gold (50× value)                          |

### 8.1 Resource Flow
- Workers gather resources up to their carry capacity, then return to the nearest storage building to deposit.
- Resources are deposited into a unified pool, subject to total storage capacity.

---

## 9. Horses

- Purchased in town for resources with a value of 20.  So 4 meat, or 10 wheat could buy a horse.
- Effect: +3 HP to the unit.  When the first 3 HP are lost on the unit the horse dies.
- Horses double travel speed and allow carrying an extra 5 resources.
- Upkeep: 2 hay OR 2 wheat per season.
- Any unit type can use a horse.

---

## 10. Actions

### 10.1 Action Table
| Action       | Unit(s)            | Season  | Duration   | Notes                                        |
|--------------|--------------------|---------|------------|----------------------------------------------|
| Plough Field | Worker             | Any     | 20 sec     | Result: ploughed tile ready to plant         |
| Plant Field  | Worker             | Spring  | 20 sec     | Requires 1 wheat per tile as seed            |
| Harvest      | Worker             | Fall    | 20 sec     | Yields 4 wheat per tile                      |
| Collect Wood | Worker             | Any     | 1 Wood / 5 sec |  |
| Fishing      | Worker / Soldier   | Any     | 1 Meat / 5 sec | Seasonal variance lands in M4 (faster in summer, slower in winter) |
| Building     | Worker             | Any     | varies   | varies by building |
| Mining       | Worker / Soldier   | Any     | 1 yield / 5 sec | Yields stone/iron/gold; small diamond chance from gold mines |

### 10.2 Action Mechanics
- Duration is the real world second cost for one completion of the action.
- A worker performs actions continuously until interrupted, capacity is reached, or season-locked actions become invalid (see the unit order/task model in §6.5).
- Action progress is shown via a progress indicator over the unit or target tile.

---

## 11. Farming Lifecycle

1. **Plough** a grass tile (20 sec, any season).
2. **Plant** the ploughed tile (20 sec, spring only, consumes 1 wheat as seed).
3. **Grow** through summer (automatic).
4. **Harvest** in fall (20 sec; yields 4 wheat per tile).
5. If not harvested before fall ends, the crop is lost.
6. Ploughed but unplanted tiles persist into the next season.

> **Hay fields** are separate from the wheat lifecycle: they are designated on grass for a wood fencing cost, do not need ploughing or annual replanting, and produce hay continuously.

---

## 12. Wood Gathering

- Worker stands on or adjacent to a forest tile and chops.
- Yields wood gradually (1 wood per 5 seconds).
- Worker carries up to 5 wood, then must walk to storage.
- Forest tiles deplete after 5 wood is harvested and become stumps; the tile is then bare grass and buildable.
- Regrowth: Forest stumps will regrow at the start of spring.

---

## 13. Mining

### 13.1 Setup
- Worker builds a mine on a mountain tile (4 wood, 30 sec). The mountain is impassable while bare, so the worker builds it from an adjacent tile; the mountain becomes walkable once the mine is complete (see §4.2). Mountains whose every neighbour is also impassable cannot host a mine.
- On completion, the mine is randomly assigned a type:
  - Stone (most common — e.g., 50%)
  - Iron (less common — e.g., 40%)
  - Gold (rare — e.g., 10%)
- Mines can be destroyed, losing resources spent creating it, but they can be rebuilt and randomly assigned a new type.

### 13.2 Operation
- A worker (or soldier) inside the mine produces ore over time (1 yield / 5 sec).
- Carry limit applies; worker returns to storage when full.
- Iron and gold mines attract goblin attacks: for each mining interval there is a **15% chance** of a goblin spawning near the mine. (Spawn cadence is tied to the mining-yield interval; M5/M6 may tune this independently.)
- Gold mines have a 10% chance to produce a diamond instead of gold per yield.

### 13.3 Mine Exhaustion
- Mines do not exhaust, but can only be occupied by one worker at a time.

---

## 14. Fishing

- Worker or soldier on a tile adjacent to water can fish.
- Current tuned base rate: **1 Meat / 5 sec** in all seasons. Seasonal variance (faster in summer, slower in winter) lands in M4 alongside the rest of the season-locked rules.
- Yields meat as a resource.
- Carry limit applies.

---

## 15. Seasons and Year Cycle

### 15.1 Season Order
Spring → Summer → Fall → Winter → (Year++; end-of-year event) → Spring …

### 15.2 Season Duration
- Each season lasts a configurable real-time duration; **default 60 seconds**, exposed as a single adjustable constant (expected to be tuned during balancing).
- A visible season indicator and timer in the HUD shows current season and time remaining.

### 15.3 Seasonal Activity Rules
- **Spring**: Planting allowed. Standard rates otherwise.
- **Summer**: Fishing bonus.
- **Fall**: Harvesting allowed. Wheat must be harvested before winter or it is lost.
- **Winter**: Reduced fishing. Crops cannot be planted or harvested.

---

## 16. End-of-Year Events

At the end of winter (year transition), a special event triggers. The upcoming event is announced at the start of that year (displayed in the HUD), so the player can prepare.

### 16.1 Attack
- Enemy units spawn at a **random map edge** and march toward the hamlet.
- Quantity and composition of enemies scale with the hamlet's "size". The exact scaling metric **varies per event** — each attack event defines which hamlet attribute(s) it keys off (e.g., number of workers, number of houses, presence of a smithy/barracks, total resource value) and the resulting enemy count and type mix.
- The player wins the encounter if all enemies are defeated or repelled; otherwise units, buildings, or resources are lost. If the Main Hall or all workers are destroyed, the game is over.

### 16.2 Tax
- A specified amount of gold is demanded. The amount **varies per event** and may be flat or scale with hamlet-size attributes, depending on the event definition.
- If gold is insufficient, the shortfall's equivalent value is taken at **double** the rate from other resources. **The player chooses which resources to surrender**, each counting toward the demand at its listed value.
- If resources are still insufficient, **the player chooses which building(s) to surrender**; each building has a money value that counts toward covering the remaining tax.

### 16.3 Misc Events
A library of 6–10 misc events provides variety. Each is defined by the data table below; most magnitudes are TBD and set during balancing. The Travelling Salesman's inventory is a **random set chosen per occurrence** of the event.

| Event               | Good/Bad | Effect (magnitude TBD)                                        |
|---------------------|----------|--------------------------------------------------------------|
| Bountiful Harvest   | Good     | +X% to a stored resource                                     |
| Crop Blight         | Bad      | 50% of stored wheat destroyed                                |
| Travelling Salesman | Good     | Offers a random set of goods for purchase for a short window |
| Plague              | Bad      | Lose a random unit, or an HP penalty across all units        |
| Festival            | Good     | Temporary production bonus and reduced build times           |
| _TBD_               | —        |                                                              |
| _TBD_               | —        |                                                              |
| _TBD_               | —        |                                                              |

### 16.4 Event Announcement
- At the start of each year (after the previous year's event resolves), the HUD displays the upcoming end-of-year event type so the player can plan.
- Specific magnitude (e.g., exact tax amount) is hidden until the event triggers — only the event type is revealed in advance.

---

## 17. Combat

### 17.1 Resolution
- When two opposing units are adjacent, they attack each other **once per second**.
- Each attack rolls a random integer within the attacker's attack range (e.g., 0–2 → 0, 1, or 2), then subtracts the defender's defense. **Minimum damage on any hit is 0** (never negative).
- A unit at 0 HP dies and is removed from the map.
- **One combat system resolves all fighting** — year-end attacks, goblins spawned at iron/gold mines (§13.2), and serpent/kraken fishing attacks (§17.3) all use this same adjacency + (roll − defense) resolution.

### 17.2 Player Combat Units
- Soldiers and captains are the primary combat units.
- Workers can defend themselves (attack 0–2) but are weak.
- Equipped weapons/armor modify stats.

### 17.3 Enemy AI
- Enemies move toward the nearest building or unit and attack.
- Goblins from mines focus on the mining unit first, then the nearest target.
- Sea serpents and kraken never leave the water; they **only attack units that are actively fishing** from a water-adjacent tile. Once they appear they remain in that water until winter, even if their target is killed.

---

## 18. Town (External Marketplace)

- A fixed **location on the map** far from the Main Hall. There is no town menu/screen — units must physically travel there carrying goods.
- Units can buy or sell **all basic resources** at their listed values, and purchase **horses** (cost = 20 in resource value, e.g., 4 meat or 10 wheat).
- A trade requires a unit to carry goods to town and carry purchases back.
- Town Interface. When a worker gets to town, show a dialog / window to facilitate trading. 
- It will need three areas, one with items for purchase in town, one with items currently stored in town and one with items carried by the unit that went to town. 
-  The user can move items freely between town storage and the worker inventory. 
-  If there are multiple units in town, only one needs to show up in the UI.
-  The user can select items from town that he wants to buy, and they will be collected in a list / area like a shopping cart. 
-  Then the user can choose items to trade from the town storage or the worker's inventory.  If the items offered for trade have equivalent or greater value than the item
requested then the trade can proceed, otherwise the town shopkeeper will reject the trade. 
-  When items are stored in town they are not counted towards the hamlet resource cap. 
-  The user can move a unit to town, unload inventory and return to the hamlet, without any trades.

---

## 19. HUD

### 19.1 Persistent Elements
- **Resource bar**: current quantity of each resource with icons.
- **Population display**: current workers / soldiers / captains, and housing capacity.
- **Season and date**: current season, year, and time remaining in current season.
- **Upcoming event**: icon and label for the end-of-year event.
- **Selected unit panel**: details (type, HP, current action, equipment) for the selected unit(s).
- **Build menu**: list of buildings/actions available given current selection and resources.

### 19.2 Interaction
- Left click building icon to enter placement mode; left click on map to place.
- Click action icon to assign action to selected unit(s).
- Hover tooltips for icons describe costs and effects.

---

## 20. Input

- **Mouse**:
  - Left click: select unit / building / UI element. Click a building tile to single-select that building.
  - Drag: box-select multiple units. (Buildings are click-only — drag-select does not pick them.)
  - Right click (or context): move or action target. In placement mode, right-click cancels placement.
- **Keyboard**:
  - Arrow keys / WASD: camera pan.
  - Number keys 1–6: enter placement mode for House (1), Barn (2), Smithy (3), Barracks (4), Mine (5), Hay Field (6). Left-click then places.
  - F: plough the hovered grass tile with the selected workers.
  - X: demolish the selected building (Main Hall excluded).
  - R: repair the selected building with the selected workers.
  - K / L: craft Sword / Shield at the selected smithy.
  - T: train selected unit at the selected barracks (worker → soldier or soldier → captain, by source kind).
  - C: cancel the current order on selected units.
  - Space: pause.
  - Escape: cancel placement mode / clear selection / close menu.
  - Number keys 7–9 (control groups): deferred — not in v1.

---

## 21. Game Flow

1. **Intro screen**: title, "New Game" button, "Load Game" button (if save exists), and possibly Options/Credits.
2. **New game**: map generated, starting state placed.
3. **Gameplay**: continuous play through seasons.
4. **End-of-year event**: triggered automatically.
5. **Win/Loss**:
   - Loss condition: losing the Main Hall, or all workers
   - Win condition: TBD — endless
6. **Game over screen**: shows statistics (years survived, peak population, etc.) and option to restart.

### 21.1 Game Phase State Machine
The game runs as a top-level state machine; the simulation only advances normal play in the `Playing` phase.
- `Intro` → (New Game / Load) → `Playing`
- `Playing` ⇄ `Paused` (Space)
- `Playing` → `EndOfYearEvent` at the winter→spring boundary. The event (attack / tax / misc) is a **modal interruption**: season progress is suspended while it resolves, then control returns to `Playing` for the new year. (An Attack event still uses the live simulation to fight the wave; "modal" means no new season time passes until it is resolved.)
- `Playing` / `EndOfYearEvent` → `GameOver` when a loss condition is met (Main Hall destroyed or all workers dead).
- `GameOver` → (Restart) → `Intro`

---

## 22. Audio (Optional / TBD)

 No audio at this time

---

## 23. Accessibility

- Color choices should remain readable; consider colorblind-friendly icons/labels.
- Keyboard controls for primary actions where feasible.
- Adjustable game speed (optional, future).

---

## 24. Non-Functional Requirements

- Game should load fully within 5 seconds on a modern broadband connection.
- Should run smoothly (≥30 FPS) on mid-range hardware.
- All assets bundled or served from the same origin to avoid CORS issues.
- No external **runtime** dependencies beyond a modern browser (Chrome, Firefox, Safari, Edge — latest 2 versions). Build-time/dev dependencies (TypeScript, Vite, Vitest — see §2.8) are permitted, since they compile and bundle away to the shipped static files.

---

## 25. Out of Scope (for v1)

- Multiplayer.
- Online leaderboards.
- Mobile/touch controls (desktop browser focus first).
- Procedurally generated story or quests beyond the defined event system.
- Modding support.
- Difficulty settings (single fixed difficulty in v1).
- In-game tutorial / onboarding.
- Adjustable game speed (pause is supported; variable speed is a possible future update).
- Named save slots (single auto-save + manual save only; slots are a possible future update).
- Audio.
- Frame-based sprite animation.

---

## 26. Outstanding Balancing Values (To Be Tuned)

All prior open design questions have been resolved and folded into the sections above. The following **numeric values** remain to be set during balancing (M7); the listed defaults may be used until then.

| Value                                  | Section   | Current / Default                |
|----------------------------------------|-----------|----------------------------------|
| Wheat yield per harvested tile         | §11       | 4 wheat per tile                 |
| Wood gathering rate                    | §10 / §12 | 1 wood / 5 sec                   |
| Fishing base rate                      | §10 / §14 | 1 meat / 5 sec (season variance pending M4) |
| Mining yield rate                      | §10 / §13 | 1 yield / 5 sec                  |
| Mine type probabilities                | §13.1     | Stone 50% / Iron 40% / Gold 10%  |
| Diamond chance from gold mine          | §13.2     | 10% per yield                    |
| Goblin spawn chance at iron/gold mine  | §13.2     | 15% per mining interval          |
| Season duration                        | §15.2     | 60 sec                           |
| Building HP values                     | §7        | 50–100 (see table)               |
| Per-event tax amounts & scaling        | §16.2     | Defined per event                |
| Per-event enemy counts & type mix      | §16.1     | Defined per event                |
| Misc event magnitudes & full roster    | §16.3     | TBD (table to be filled in)      |
| Base unit movement speed               | §6.5      | 2 hexes / sec                    |
| Barracks housing capacity              | §7.4      | 4 soldiers/captains per barracks |
| Enemy loot drop rates                  | §6.1      | TBD (e.g., goblin gold chance)   |
| Goblin spawn count & placement at mine | §13.2     | TBD (count near the mine hex)    |
| Hex size (circumradius, px)            | §3.2/§4.1 | 20 (hex ≈ 35×40 px)              |
| Map size                               | §4.1      | 40 × 40 hexes                    |

---

## 27. Development Milestones

Each milestone lists its **goal**, **key deliverables**, and an **acceptance check** (a concrete, testable outcome). Milestones are ordered by dependency.

**Changes from the original phasing:**
- Added **M0 — Scaffold** to stand up the game loop, central `gameState`, and render shell before feature work, since every later system depends on them.
- Pulled **save/load forward** into M2 — round-tripping state early surfaces serialization gaps in each new system as it is added, instead of discovering them all at the end.
- Made **pathfinding/movement** an explicit M1 deliverable and gave the **town economy + horses** their own slot in M5; the original list folded both in implicitly.
- Added explicit acceptance checks so each phase has a clear "done" signal.
- Folded the architecture foundations (§2.6–§2.10: sim/render split, plain-data state, seeded RNG, tick model, tooling) into **M0**, since every later system depends on them.

**M0 — Scaffold**
- Goal: A running, empty game shell on the target architecture.
- Deliverables: TypeScript + Vite + Vitest + Playwright project; `index.html` + module loading; the `game/` (sim) ↔ `render/` ↔ `ui/` separation (§2.6) with a stateless `update(state, commands)` core; plain-data id-based `gameState` + seeded PRNG; tick-based fixed-timestep loop (30/sec, §2.7) decoupled from `requestAnimationFrame`; config-data skeleton (§2.6); HTML/CSS HUD shell; pause (Space); dev-only `window.__game` sim hook (`getState`, `enqueue`, `tick`) for browser play-tests (§2.10).
- Acceptance: Page loads, the loop ticks at a stable rate, pause halts the sim but not rendering, a trivial headless sim test runs under Vitest, and a Playwright smoke test boots the page console-error-free.

**M1 — Map, Camera & Selection**
- Goal: A navigable world with selectable, movable units.
- Deliverables: 40×60 procedural map gen with terrain constraints (§4.3); 32×32 tile rendering; camera (keyboard pan + edge-scroll); A\* pathfinding on walkable tiles; unit rendering, click/drag-box selection, right-click move.
- Acceptance: Player can select one or many units and order them to walk around terrain via pathfinding.

**M2 — Worker Loop & Persistence**
- Goal: The core gather-and-deposit economy, savable.
- Deliverables: Wood chopping (with depletion/stumps), farming lifecycle (plough/plant/grow/harvest), fishing, basic mining; carry caps and deposit-to-nearest-storage; pooled storage limit; HUD resource bar; LocalStorage auto-save + manual save/load; Playwright browser play-test covering the gather→deposit cycle and save/reload via `window.__game`.
- Acceptance: A worker gathers each resource type, deposits respecting caps, and the full game state survives a save/reload — verified both by the Vitest sim suite and by the M2 Playwright play-tests.

**M3 — Buildings**
- Goal: The full construction system.
- Deliverables: Placement mode + validity rules (§7.1); under-construction sprites (semi-transparent fill with a gold progress bar); all building types (house/barn/smithy/barracks/mine + hay-field tile feature); smithy crafting (1 season/item, output to a global equipment pool); barracks training paths gated by barracks housing (§7.4); repair and demolish. Mining now requires a built Mine on the mountain tile (§13.1); mine type is rolled at construction completion.
- New commands wired through the sim: `build`, `repair`, `demolish`, `craft`, `train`, `cancel`. New unit orders: `build` (construction/repair), `operate` (smithy/barracks "enter and work" loop, with the operator hidden from the map while inside).
- Input layer: digit hotkeys 1–6 enter placement mode for each building kind; X/R/K/L/T/C drive demolish/repair/craft-sword/craft-shield/train/cancel on the current selection.
- Acceptance: Player can build, repair, and demolish each building type and craft/train from the relevant buildings — verified by the Vitest sim suite (`test/buildings.test.ts`) and Playwright (`e2e/m3.spec.ts`).

**M4 — Seasons, Time & Upkeep**
- Goal: The yearly cycle drives gameplay.
- Deliverables: Season/year progression with HUD timer; season-locked actions (plant=spring, harvest=fall, fishing-rate variance); end-of-season upkeep with demotion rules (§6.3); housing/population caps (§7.4); crop loss if unharvested by winter; forest regrowth at spring.
- Acceptance: A full year cycles correctly; upkeep is charged and demotes/kills units per §6.3; season-locked actions are gated.

**M5 — Combat, Town & Horses**
- Goal: Military units, the town marketplace and mounts.
- Deliverables: Soldier/captain units; equipment (sword/shield) affecting stats and carry; combat resolution (1/sec, roll − defense, min 0); horses (+3 HP, ×2 speed, +5 carry, upkeep); town location with exchanging resources + horse purchase.
- Acceptance: Units fight per the damage formula; a unit can travel to town to trade and buy a horse, then carries more and moves faster.

**M6 — Enemies & End-of-Year Events**
- Goal: The seasonal threat loop.
- Deliverables: Enemy AI (goblins, sea serpent, kraken) with targeting rules (§17.3); mine goblin spawns; year-end event system — Attack (random-edge spawn, hamlet-size scaling), Tax (gold → double resources → buildings, player-selected), Misc event library; upcoming-event announcement in HUD.
- Acceptance: Each event type triggers at year end and resolves correctly; loss conditions (Main Hall destroyed / all workers dead) end the game.

**M7 — Polish & Balancing**
- Goal: Ship-ready feel.
- Deliverables: Intro and game-over screens (with run stats); tune the outstanding balancing values (§26); tooltips; readability/colorblind pass.
- Acceptance: A new player can start from the intro, play multiple years, lose, and see end-of-run stats — with values that feel balanced.


