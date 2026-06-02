// Riderless horse entities (req §9). A horse is normally "absorbed" into its
// rider — a mounted unit just carries `horseHp` (the buffer HP, speed, and carry
// bonus). A horse only becomes a standalone entity when it has *no* rider: on
// dismount it appears at the unit's tile and pathfinds to the nearest Stables,
// where it waits to be re-mounted. Plain, id-based, JSON-serializable data like
// every other entity (req §2.6); the rider/horse split keeps combat, speed, and
// carry logic (which all read `Unit.horseHp`) unchanged.

import type { TileCoord } from "./map.js";

export interface Horse {
  id: number;
  x: number; // tile-space column (fractional while trotting home)
  y: number; // tile-space row
  // Buffer HP carried over from the rider on dismount; restored to the next
  // rider on mount. Horses don't regenerate, so this only ever decreases.
  hp: number;
  // Route to the Stables this horse is heading for; empty once parked (or while
  // it waits in place because no Stables exists yet).
  path: TileCoord[];
  node: number;
  // True once the horse has reached a mature Stables tile and parked there.
  stabled: boolean;
}

export function makeHorse(
  id: number,
  x: number,
  y: number,
  hp: number,
  path: TileCoord[] = [],
): Horse {
  return { id, x, y, hp, path, node: 0, stabled: false };
}
