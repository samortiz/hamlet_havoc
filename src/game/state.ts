// Central game state (req §2.6). Plain, serializable, id-based data only —
// no class instances, functions, or cross-entity object references, so the
// whole object is JSON.stringify-able with no cycles.

import {
  SEASONS,
  TICKS_PER_SEASON,
  TICKS_PER_SECOND,
  TICKS_PER_YEAR,
  type Season,
} from "../config/index.js";
import { generateMap, HAMLET_CENTER, type GameMap } from "./map.js";
import { makeWorker, type Unit } from "./units.js";

export const SAVE_VERSION = 1;

export interface GameState {
  version: number;
  tickCount: number;
  // Seeded PRNG state (see rng.ts). Lives in state so saves stay deterministic.
  rngState: number;
  // Monotonic id source for entities.
  nextEntityId: number;
  map: GameMap;
  units: Record<number, Unit>;
}

export function createInitialState(seed: number): GameState {
  const gen = generateMap(seed >>> 0);
  const units: Record<number, Unit> = {};
  let nextEntityId = 1;

  // 4 starting workers in the hamlet clearing (req §5). Buildings arrive in M3.
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  for (const [dx, dy] of offsets) {
    const id = nextEntityId++;
    units[id] = makeWorker(id, HAMLET_CENTER.x + dx, HAMLET_CENTER.y + dy);
  }

  return {
    version: SAVE_VERSION,
    tickCount: 0,
    rngState: gen.rngState,
    nextEntityId,
    map: gen.map,
    units,
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
