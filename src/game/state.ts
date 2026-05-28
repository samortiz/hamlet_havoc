// Central game state (req §2.6). Plain, serializable, id-based data only —
// no class instances, functions, or cross-entity object references, so the
// whole object is JSON.stringify-able with no cycles.

import {
  SEASONS,
  STARTING_WHEAT,
  TICKS_PER_SEASON,
  TICKS_PER_SECOND,
  TICKS_PER_YEAR,
  type Season,
} from "../config/index.js";
import { makeBuilding, type Building, type BuildingKind } from "./buildings.js";
import type { Field } from "./fields.js";
import { generateMap, HAMLET_CENTER, type GameMap } from "./map.js";
import { emptyPool, type ResourcePool } from "./resources.js";
import { makeWorker, type Unit } from "./units.js";

// Bumped to 2 in M2: state gained buildings/fields/resources, so M1 saves are
// no longer loadable and are rejected by deserialize().
export const SAVE_VERSION = 2;

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
  resources: ResourcePool;
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
  const placements: ReadonlyArray<{ kind: BuildingKind; x: number; y: number }> = [
    { kind: "mainHall", x: cx, y: cy },
    { kind: "house", x: cx - 2, y: cy },
    { kind: "house", x: cx + 2, y: cy },
  ];
  for (const p of placements) {
    const id = nextEntityId++;
    buildings[id] = makeBuilding(id, p.kind, p.x, p.y);
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
    resources,
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
  const tickInYear = tickCount % TICKS_PER_YEAR;
  const seasonIndex = Math.floor(tickInYear / TICKS_PER_SEASON);
  const tickInSeason = tickInYear % TICKS_PER_SEASON;
  const ticksRemaining = TICKS_PER_SEASON - tickInSeason;
  return {
    year,
    season: SEASONS[seasonIndex],
    seasonIndex,
    secondsRemaining: Math.ceil(ticksRemaining / TICKS_PER_SECOND),
  };
}
