// Season/year progression (req §15, §2.3 `season.js`). Pure functions derived
// purely from the tick count (req §2.7: never wall-clock) — the calendar is a
// view of `tickCount`, never stored separately, so pause and save/load behave
// correctly. The ctx-mutating end-of-season systems (upkeep, crop loss, forest
// regrowth) live in actions.ts and call `seasonBoundaries` from here.

import {
  SEASONS,
  TICKS_PER_SEASON,
  TICKS_PER_YEAR,
  type Season,
} from "../config/index.js";
import type { FieldAction } from "./units.js";

// Season index 0..3 (Spring..Winter) for a tick count.
export function seasonIndexAt(tickCount: number): number {
  const tickInYear = ((tickCount % TICKS_PER_YEAR) + TICKS_PER_YEAR) % TICKS_PER_YEAR;
  return Math.floor(tickInYear / TICKS_PER_SEASON);
}

export function seasonAt(tickCount: number): Season {
  return SEASONS[seasonIndexAt(tickCount)];
}

// A season boundary: the instant one season ends and the next begins. Boundaries
// fall on every multiple of TICKS_PER_SEASON (k·TICKS_PER_SEASON for k ≥ 1).
export interface SeasonBoundary {
  endedIndex: number; // season that just ended (0..3)
  startedIndex: number; // season that begins (0..3)
  startsYear: boolean; // true when the new season is Spring (year rollover)
}

// Every season boundary strictly after `prevTick`, up to and including `newTick`.
// A single update() step may span more than one boundary when fast-forwarded
// (the e2e `tick(n)` seam, §2.10); production steps one tick at a time so it
// crosses at most one. Boundaries are half-open on the low side so a tick that
// lands exactly on a boundary is processed once, by the step that reaches it.
export function seasonBoundaries(prevTick: number, newTick: number): SeasonBoundary[] {
  const out: SeasonBoundary[] = [];
  const firstK = Math.floor(prevTick / TICKS_PER_SEASON) + 1;
  const lastK = Math.floor(newTick / TICKS_PER_SEASON);
  const n = SEASONS.length;
  for (let k = firstK; k <= lastK; k++) {
    if (k <= 0) continue;
    const startedIndex = k % n;
    const endedIndex = (k - 1 + n) % n;
    out.push({ endedIndex, startedIndex, startsYear: startedIndex === 0 });
  }
  return out;
}

// Season-locked farming actions (req §10.1, §11, §15.3): plant is spring-only,
// harvest is fall-only, plough is allowed in any season.
export function fieldActionInSeason(action: FieldAction, season: Season): boolean {
  if (action === "plant") return season === "Spring";
  if (action === "harvest") return season === "Fall";
  return true; // plough
}
