// Unit entities (req §6). Plain data, referenced by integer id from GameState.
// Position is in tile-space (fractional while moving). Orders drive behavior via
// a small per-unit state machine (req §6.5). M2 adds the gather/farming orders;
// the rest (train/trade/attack) arrive in later milestones.

import { WORKER_CARRY_CAP } from "../config/index.js";
import type { TileCoord } from "./map.js";
import type { Inventory } from "./resources.js";

export type UnitKind = "worker" | "soldier" | "captain";

// What a gather order is harvesting. The work tile differs per resource: wood =
// the forest tile, ore = the mountain tile, fish = a land tile adjacent to water.
export type GatherResource = "wood" | "fish" | "ore";

export type FieldAction = "plough" | "plant" | "harvest";

export type Order =
  | { type: "idle" }
  | { type: "move"; path: TileCoord[]; node: number }
  | {
      type: "gather";
      resource: GatherResource;
      wx: number; // work/standing tile
      wy: number;
      phase: "toWork" | "working" | "toStore" | "storing";
      path: TileCoord[];
      node: number;
      workTicks: number; // accumulated toward the next yield
      storeId: number | null; // storage building targeted while returning
    }
  | {
      type: "field";
      action: FieldAction;
      tx: number;
      ty: number;
      phase: "toTile" | "working";
      path: TileCoord[];
      node: number;
      workTicks: number; // accumulated toward completion
    };

export interface Unit {
  id: number;
  kind: UnitKind;
  x: number; // tile-space column (fractional while moving)
  y: number; // tile-space row
  hp: number;
  carrying: Inventory;
  order: Order;
}

export function carryCap(_unit: Unit): number {
  // Only the worker gathers in M2 (cap 5, §6.1). Soldier/captain caps arrive in M5.
  return WORKER_CARRY_CAP;
}

export function makeWorker(id: number, x: number, y: number): Unit {
  return { id, kind: "worker", x, y, hp: 2, carrying: {}, order: { type: "idle" } };
}
