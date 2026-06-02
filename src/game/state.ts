// Central game state (req §2.6). Plain, serializable, id-based data only —
// no class instances, functions, or cross-entity object references, so the
// whole object is JSON.stringify-able with no cycles.

import {
  STARTING_WHEAT,
  TICKS_PER_SECOND,
  TICKS_PER_SEASON,
  TICKS_PER_YEAR,
  type Season,
} from "../config/index.js";
import { seasonAt, seasonIndexAt } from "./season.js";
import { makeBuilding, type Building, type BuildingKind } from "./buildings.js";
import type { DamageEvent, Enemy, HealEvent } from "./combat.js";
import {
  chooseUpcomingEvent,
  type ActiveEvent,
  type EventCategory,
  type UpcomingEvent,
} from "./events.js";
import type { Field } from "./fields.js";
import type { Horse } from "./horses.js";
import { generateMap, HAMLET_CENTER, type GameMap, type TileCoord } from "./map.js";
import { emptyPool, type ResourcePool, type ResourceType } from "./resources.js";
import { makeWorker, type Unit } from "./units.js";

// Bumped to 4: the board switched from a square 40×60 grid to a 40×40
// pointy-top hex grid (req §4.1). Building/Unit (x, y) now name odd-r hex
// coordinates rather than square tile coordinates, so v3 saves restored
// verbatim would have buildings landing in geometrically different places.
// Rejected by deserialize().
//
// Previous bumps: 2 (fields/buildings/resources), 3 (build
// progress/occupants/equipment).
//
// Seasons/upkeep added no new persisted fields — the calendar is derived
// from `tickCount` and upkeep/crop-loss/regrowth mutate existing state — so the
// serialized shape is unchanged and the version stays at 4.
//
// Bumped to 5 for combat/town/horses: units gained `equipped`, `horseHp`,
// and `attackCooldown`; GameState gained the `enemies` map and the `town` tile.
// A v4 save lacks these, so it is rejected by deserialize().
//
// Bumped to 6 for the town marketplace interface (req §18): GameState gained
// `townStorage`, the pool of goods deposited at town (kept separate from
// `resources` so it does not count against the hamlet storage cap). A v5 save
// lacks it, so it is rejected by deserialize().
// v7: per-tile `map.mountainType` — old saves lack it and are rejected.
// v8: Building gains `spawning`/`spawnProgress` for Main Hall worker production.
// v9: GameState gains `notifications` — the rolling event log surfaced to the
// player when a unit starves/demotes or a horse dies.
// v10: enemy AI — `Enemy` gains `focusUnitId`/`path`/`node` for movement &
// targeting. A v9 save's enemies lack these, so it is rejected by deserialize().
// v11: end-of-year events — GameState gains the game `phase`, the announced
// `upcomingEvent`, the resolving `activeEvent`, `yearsSinceAttack`, the
// year-long `eventMods`, and run `stats`. A v10 save lacks these, so it is
// rejected by deserialize().
// v12: enemy loot — GameState gains `groundItems`, the loose resource stacks
// dropped by killed enemies that a unit can walk over to collect (req §6.2). A
// v11 save lacks it, so it is rejected by deserialize().
// v13: water-predator lifecycle — `Enemy` gains `spawnTick` so a sea serpent /
// kraken despawns one year after it surfaces (req §14, §17.3). A v12 save's
// enemies lack it, so it is rejected by deserialize().
// v14: deterministic year-end cadence — GameState swaps `yearsSinceAttack` for
// `eventSchedule` (the remaining shuffled categories of the current 3-year
// block, §16.0). A v13 save has the wrong shape, so it is rejected by
// deserialize().
// v15: tax flavours — a resolving tax `activeEvent` gains a `flavour` naming the
// keyed demand formula (§16.2). A v14 save mid-tax lacks it, so it is rejected
// by deserialize().
// v16: rebuilt Misc library (§16.3) — the MiscEventKind set changed (new events,
// dropped travellingSalesman/wanderingRecruits/banditShakedown) and a resolving
// trade-dialog Misc `activeEvent` gains a `trade` state (item 31/32). A v15 save
// may carry a now-unknown misc kind or lack `trade`, so it is rejected on load.
// v17: hay deprecated as a resource (req §8) — it is removed from `RESOURCE_TYPES`,
// so every `ResourcePool`/`Inventory` (the `resources`/`townStorage` pools and
// each unit's `carrying`) drops its `hay` key. A v16 save still carries `hay`, so
// it is rejected on load.
// v18: tax payment is fully player-chosen (req §16.2.1) — the `tax` ActiveEvent
// drops its auto-pay `remaining`/`autoGold` fields, carrying only `demand`.
// v19: attacks are no longer modal (req §16.1) — an Attack stays in `playing`
// (spawn + warning, fought live) instead of entering `endOfYearEvent`, so the
// `attack` ActiveEvent variant is gone. A v18 save paused mid-attack would carry
// an unresolvable `{phase:"endOfYearEvent", activeEvent:{category:"attack"}}`, so
// it is rejected on load.
// v20: the "hay field" tile feature was renamed to "Stables" — the serialized
// `Field.kind` value `"hay"` became `"stables"` and its stages `"hayBuilding"`/
// `"hayMature"` became `"stablesBuilding"`/`"stablesMature"`. A v19 save still
// carries the old strings, so it is rejected on load.
// v21: dismountable horses (req §9) — GameState gains the `horses` map of
// riderless horse entities (a dismounted mount walks to the nearest Stables to
// wait). A v20 save lacks the field, so it is rejected on load.
export const SAVE_VERSION = 21;

// Most recent notifications kept on the state. The UI dedups by id and only
// toasts ones it hasn't shown yet, so this just bounds save size — older entries
// fall off the front once the cap is exceeded.
export const MAX_NOTIFICATIONS = 12;

// Equipment crafted at the smithy lives in a small global pool (req §7.2).
// Units pull from this pool when equipping in M5; the smithy posts here when
// an item completes. Kept separate from `resources` because equipment is not
// freely trade-valued like wheat or wood.
export interface EquipmentPool {
  sword: number;
  shield: number;
}

// A player-facing event. Emitted by the sim when something happens the
// player should know about but didn't directly order — a worker starving, a
// unit demoted for unpaid upkeep, a horse lost. `id` is allocated from the same
// monotonic entity counter so the UI can dedup and toast only new ones.
export type NotificationKind = "death" | "demotion" | "enemy";
export interface GameNotification {
  id: number;
  tick: number;
  kind: NotificationKind;
  message: string;
  // Optional world location the notice points at: set for enemy sightings
  // so clicking the toast centres the camera on the combat. Absent for upkeep
  // notices, which have no single place to jump to.
  x?: number;
  y?: number;
}

// Top-level game phase (req §21.1). The sim only advances normal play in
// `playing`; a year-end event is a modal interruption (`endOfYearEvent`) that
// suspends season time while it resolves; a loss flips it to `gameOver`. (The
// req's `Intro`/`Paused` phases are loop/UI concerns: pause stops the loop from
// calling update() at all.)
export type GamePhase = "playing" | "endOfYearEvent" | "gameOver";

// Year-long event modifiers (req §16.3). Set when the matching Misc event fires;
// `festival`/`mildWinter` stay active for the coming year (cleared when the next
// year-boundary event triggers); `harshUpkeep` is consumed at the next season end.
export interface EventModifiers {
  festival: boolean; // +25% gather, −25% build/craft/train this year
  mildWinter: boolean; // skip winter fishing penalty + worker upkeep this year
  harshUpkeep: boolean; // double the next end-of-season upkeep
}

// A loose stack of a single resource lying on a tile (req §6.2). Dropped when a
// killed enemy's loot doesn't fit the killer's cart (or for water predators,
// whose loot always surfaces on the attacker's tile); any unit walking over the
// tile with carry room collects it. Id-based like every other entity (req §2.6).
export interface GroundItem {
  id: number;
  x: number;
  y: number;
  resource: ResourceType;
  qty: number;
}

// Run statistics surfaced on the game-over screen (req §21).
export interface RunStats {
  peakPopulation: number;
  yearsSurvived: number; // year-end events successfully weathered
}

export interface GameState {
  version: number;
  tickCount: number;
  // Game phase + the end-of-year event system (req §16, §21.1).
  phase: GamePhase;
  // The event announced for the *current* year, firing at its winter→spring
  // boundary. Only its type is known until the event triggers (§16.0, §16.4).
  upcomingEvent: UpcomingEvent;
  // The event currently resolving while `phase === "endOfYearEvent"`; null
  // otherwise. Carries the rolled magnitude + any player-choice state.
  activeEvent: ActiveEvent | null;
  // The categories remaining in the current year-end cadence block, already
  // seeded-shuffled (§16.0). One is popped per year to set `upcomingEvent`; when
  // it empties a fresh block is shuffled in. See chooseUpcomingEvent in events.ts.
  eventSchedule: EventCategory[];
  eventMods: EventModifiers;
  stats: RunStats;
  // Seeded PRNG state (see rng.ts). Lives in state so saves stay deterministic.
  rngState: number;
  // Monotonic id source for entities.
  nextEntityId: number;
  map: GameMap;
  units: Record<number, Unit>;
  buildings: Record<number, Building>;
  fields: Record<number, Field>;
  // Hostile units (req §6.1, §17). They have movement/targeting AI and
  // spawning (mine goblins, fishing predators). Keyed by id (req §2.6).
  enemies: Record<number, Enemy>;
  // Loose resource stacks on the ground (req §6.2), dropped by killed enemies and
  // picked up by units walking over them. Keyed by id (req §2.6).
  groundItems: Record<number, GroundItem>;
  // Riderless horses (req §9): a dismounted mount becomes one of these and walks
  // to the nearest Stables to wait to be re-mounted. A *mounted* horse is not
  // here — it lives as the rider's `horseHp`. Keyed by id (req §2.6).
  horses: Record<number, Horse>;
  resources: ResourcePool;
  equipment: EquipmentPool;
  // The town marketplace tile (req §18) — a fixed walkable location far from the
  // Main Hall. View-independent, so it lives in saved state.
  town: TileCoord;
  // Goods deposited at the town (req §18). A unit standing at town can move
  // resources freely between its inventory and this pool, and offer from it in
  // trades. Deliberately separate from `resources`: items stored here do *not*
  // count against the hamlet storage cap.
  townStorage: ResourcePool;
  // Rolling player-facing event log, capped at MAX_NOTIFICATIONS. Appended
  // by the sim (upkeep deaths/demotions); the HUD toasts new entries.
  notifications: GameNotification[];
  // Combat damage toasts produced this step — the renderer floats a "-N"
  // over each struck unit/enemy. Transient render-feed data: regenerated every
  // step and stripped from saves (see persistence.ts), so it carries no history.
  damageEvents: DamageEvent[];
  // Heal toasts produced this step (req §6.2) — the renderer floats a green "+N"
  // over each healed unit. Transient like damageEvents; stripped from saves.
  healEvents: HealEvent[];
}

export function createInitialState(seed: number): GameState {
  const gen = generateMap(seed >>> 0);
  const units: Record<number, Unit> = {};
  const buildings: Record<number, Building> = {};
  let nextEntityId = 1;

  const cx = HAMLET_CENTER.x;
  const cy = HAMLET_CENTER.y;

  // Starting hamlet (req §5): 1 Main Hall + 2 Houses, laid out in the grass
  // clearing. These provide the initial pooled storage and drop-off points.
  // They spawn already completed — the player did not build them.
  const placements: ReadonlyArray<{ kind: BuildingKind; x: number; y: number }> = [
    { kind: "mainHall", x: cx, y: cy },
    { kind: "house", x: cx - 2, y: cy },
    { kind: "house", x: cx + 2, y: cy },
  ];
  for (const p of placements) {
    const id = nextEntityId++;
    buildings[id] = makeBuilding(id, p.kind, p.x, p.y, { built: true });
  }

  // 4 starting workers on open clearing tiles around the buildings.
  const workerTiles: ReadonlyArray<readonly [number, number]> = [
    [cx - 1, cy + 2],
    [cx, cy + 2],
    [cx + 1, cy + 2],
    [cx, cy - 2],
  ];
  for (const [x, y] of workerTiles) {
    const id = nextEntityId++;
    units[id] = makeWorker(id, x, y);
  }

  const resources = emptyPool();
  resources.wheat = STARTING_WHEAT;

  // Roll year 1's end-of-year event up front so it can be announced from the
  // first frame (req §16.0, §16.4). Consumes the map-gen RNG state.
  const [rngState, upcomingEvent, eventSchedule] = chooseUpcomingEvent(
    gen.rngState,
    1,
    [],
  );
  const startingPop = workerTiles.length;

  return {
    version: SAVE_VERSION,
    tickCount: 0,
    phase: "playing",
    upcomingEvent,
    activeEvent: null,
    eventSchedule,
    eventMods: { festival: false, mildWinter: false, harshUpkeep: false },
    stats: { peakPopulation: startingPop, yearsSurvived: 0 },
    rngState,
    nextEntityId,
    map: gen.map,
    units,
    buildings,
    fields: {},
    enemies: {},
    groundItems: {},
    horses: {},
    resources,
    equipment: { sword: 0, shield: 0 },
    town: gen.town,
    townStorage: emptyPool(),
    notifications: [],
    damageEvents: [],
    healEvents: [],
  };
}

// Derived, read-only view of the calendar from the tick count (req §15, §2.7).
export interface SeasonInfo {
  year: number; // 1-based
  season: Season;
  seasonIndex: number; // 0..3
  secondsRemaining: number;
}

export function deriveSeason(tickCount: number): SeasonInfo {
  const year = Math.floor(tickCount / TICKS_PER_YEAR) + 1;
  const seasonIndex = seasonIndexAt(tickCount);
  const tickInSeason = ((tickCount % TICKS_PER_SEASON) + TICKS_PER_SEASON) % TICKS_PER_SEASON;
  const ticksRemaining = TICKS_PER_SEASON - tickInSeason;
  return {
    year,
    season: seasonAt(tickCount),
    seasonIndex,
    secondsRemaining: Math.ceil(ticksRemaining / TICKS_PER_SECOND),
  };
}
