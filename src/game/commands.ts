// Commands are the only way input influences the simulation (req §2.6). The
// input layer produces Commands; update() consumes them and turns them into unit
// orders. Each command carries the units it applies to and a target.
//
// Note: pause is a game-loop concern, not a Command — it stops update() from
// being called at all rather than mutating simulation state.

import type { BuildingKind, CraftItem, TrainTarget } from "./buildings.js";
import type { FieldAction } from "./units.js";

// What can be placed via a `build` command. Buildings (BuildingKind, minus
// mainHall which is pre-built) and the hay-field tile feature share the same
// placement flow: validate terrain, deduct cost, spawn an under-construction
// site, route workers to it.
export type BuildableKind = Exclude<BuildingKind, "mainHall"> | "hayField";

export type Command =
  | { type: "moveUnits"; unitIds: number[]; tx: number; ty: number }
  // Gather; the resource (wood/ore/fish) is inferred from the target tile.
  | { type: "gather"; unitIds: number[]; tx: number; ty: number }
  // Farm action (plough/plant/harvest) on the target tile.
  | { type: "field"; unitIds: number[]; action: FieldAction; tx: number; ty: number }
  // Place a building or hay-field. Validates terrain + cost; on success, the
  // selected workers are ordered to build it (req §7, §7.1).
  | { type: "build"; unitIds: number[]; kind: BuildableKind; tx: number; ty: number }
  // Repair a damaged building. Cost scales with HP missing (req §7.1).
  | { type: "repair"; unitIds: number[]; buildingId: number }
  // Demolish a building immediately. No cost refund (req §7.1).
  | { type: "demolish"; buildingId: number }
  // Send a worker into a smithy to craft the given item (req §7.2). The smithy
  // loops on the same item until ordered out or materials run out.
  | { type: "craft"; unitIds: number[]; buildingId: number; item: CraftItem }
  // Send a unit into a barracks to train (req §7.3). The trainee promotes one
  // rank when 1 season of training completes; gated by barracks housing.
  | { type: "train"; unitIds: number[]; buildingId: number; toKind: TrainTarget }
  // Stop whatever order the unit currently has and return to idle. Used to pull
  // a smithy operator out, cancel a build, etc.
  | { type: "cancel"; unitIds: number[] };
