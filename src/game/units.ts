// Unit entities (req §6). Plain data, referenced by integer id from GameState.
// Position is in tile-space (fractional while moving). Orders drive behavior;
// M1 uses idle + move, with the remaining order types (gather/build/etc., §6.5)
// added in later milestones.

import type { TileCoord } from "./map.js";

export type UnitKind = "worker" | "soldier" | "captain";

export type Order =
  | { type: "idle" }
  | { type: "move"; path: TileCoord[]; node: number };

export interface Unit {
  id: number;
  kind: UnitKind;
  x: number; // tile-space column (fractional while moving)
  y: number; // tile-space row
  hp: number;
  order: Order;
}

export function makeWorker(id: number, x: number, y: number): Unit {
  return { id, kind: "worker", x, y, hp: 2, order: { type: "idle" } };
}
