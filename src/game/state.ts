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
import type { Enemy } from "./combat.js";
import type { Field } from "./fields.js";
import { generateMap, HAMLET_CENTER, type GameMap, type TileCoord } from "./map.js";
import { emptyPool, type ResourcePool } from "./resources.js";
import { makeWorker, type Unit } from "./units.js";

// Bumped to 4: the board switched from a square 40×60 grid to a 40×40
// pointy-top hex grid (req §4.1). Building/Unit (x, y) now name odd-r hex
// coordinates rather than square tile coordinates, so v3 saves restored
// verbatim would have buildings landing in geometrically different places.
// Rejected by deserialize().
//
// Previous bumps: 2 (M2 — fields/buildings/resources), 3 (M3 — build
// progress/occupants/equipment).
//
// M4 (seasons/upkeep) added no new persisted fields — the calendar is derived
// from `tickCount` and upkeep/crop-loss/regrowth mutate existing state — so the
// serialized shape is unchanged and the version stays at 4.
//
// Bumped to 5 for M5 (combat/town/horses): units gained `equipped`, `horseHp`,
// and `attackCooldown`; GameState gained the `enemies` map and the `town` tile.
// A v4 save lacks these, so it is rejected by deserialize().
//
// Bumped to 6 for the town marketplace interface (req §18): GameState gained
// `townStorage`, the pool of goods deposited at town (kept separate from
// `resources` so it does not count against the hamlet storage cap). A v5 save
// lacks it, so it is rejected by deserialize().
// v7: per-tile `map.mountainType` (T2) — old saves lack it and are rejected.
// v8: Building gains `spawning`/`spawnProgress` for Main Hall worker production (T5).
// v9: GameState gains `notifications` — the rolling event log surfaced to the
// player when a unit starves/demotes or a horse dies (T7).
export const SAVE_VERSION = 9;

// Most recent notifications kept on the state (T7). The UI dedups by id and only
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

// A player-facing event (T7). Emitted by the sim when something happens the
// player should know about but didn't directly order — a worker starving, a
// unit demoted for unpaid upkeep, a horse lost. `id` is allocated from the same
// monotonic entity counter so the UI can dedup and toast only new ones.
export type NotificationKind = "death" | "demotion" | "horse";
export interface GameNotification {
  id: number;
  tick: number;
  kind: NotificationKind;
  message: string;
}

export interface GameState {
  version: number;
  tickCount: number;
  // Seeded PRNG state (see rng.ts). Lives in state so saves stay deterministic.
  rngState: number;
  // Monotonic id source for entities.
  nextEntityId: number;
  map: GameMap;
  units: Record<number, Unit>;
  buildings: Record<number, Building>;
  fields: Record<number, Field>;
  // Hostile units (req §6.1, §17). Stationary + injectable in M5; spawning and
  // AI land in M6. Keyed by id like every other entity (req §2.6).
  enemies: Record<number, Enemy>;
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
  // Rolling player-facing event log (T7), capped at MAX_NOTIFICATIONS. Appended
  // by the sim (upkeep deaths/demotions); the HUD toasts new entries.
  notifications: GameNotification[];
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

  return {
    version: SAVE_VERSION,
    tickCount: 0,
    rngState: gen.rngState,
    nextEntityId,
    map: gen.map,
    units,
    buildings,
    fields: {},
    enemies: {},
    resources,
    equipment: { sword: 0, shield: 0 },
    town: gen.town,
    townStorage: emptyPool(),
    notifications: [],
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
