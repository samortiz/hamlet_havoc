// Commands are the only way input influences the simulation (req §2.6). The
// input layer produces Commands; update() consumes them and turns them into unit
// orders. Each command carries the units it applies to and a target tile.
//
// Note: pause is a game-loop concern, not a Command — it stops update() from
// being called at all rather than mutating simulation state.

import type { FieldAction } from "./units.js";

export type Command =
  | { type: "moveUnits"; unitIds: number[]; tx: number; ty: number }
  // Gather; the resource (wood/ore/fish) is inferred from the target tile.
  | { type: "gather"; unitIds: number[]; tx: number; ty: number }
  // Farm action (plough/plant/harvest) on the target tile.
  | { type: "field"; unitIds: number[]; action: FieldAction; tx: number; ty: number };
