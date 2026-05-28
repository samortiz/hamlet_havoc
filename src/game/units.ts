// Unit entities (req §6). Plain data, referenced by integer id from GameState.
// Position is in tile-space (fractional while moving). Orders drive behavior via
// a small per-unit state machine (req §6.5). M2 adds the gather/farming orders;
// M3 adds build/operate (construct, repair, smithy craft, barracks train). The
// rest (trade/attack) arrive in later milestones.

import { UNIT_MAX_HP, WORKER_CARRY_CAP } from "../config/index.js";
import type { TileCoord } from "./map.js";
import type { Inventory } from "./resources.js";

export type UnitKind = "worker" | "soldier" | "captain";

// What a gather order is harvesting. The work tile differs per resource: wood =
// the forest tile, ore = the mountain tile (with a built mine on it; req §13),
// fish = a land tile adjacent to water.
export type GatherResource = "wood" | "fish" | "ore";

export type FieldAction = "plough" | "plant" | "harvest";

// What an `operate` order does inside the building (req §7.2, §7.3, §13).
// `craftSword`/`craftShield`: smithy production loop.
// `trainSoldier`/`trainCaptain`: barracks promotion of the unit doing the order.
// `mine`: enter a Mine and pull ore until carry-cap full, then go deposit.
export type OperateMode =
  | "craftSword"
  | "craftShield"
  | "trainSoldier"
  | "trainCaptain"
  | "mine";

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
    }
  // Build/repair: walk to the construction site, then accumulate progress
  // onto the target building each tick (req §7). One worker is enough; multiple
  // workers add their progress, so two builders finish twice as fast.
  | {
      type: "build";
      buildingId: number;
      // `repair: true` means we're restoring HP on a finished building, not
      // accumulating construction progress on a new one.
      repair: boolean;
      phase: "toSite" | "working";
      path: TileCoord[];
      node: number;
    }
  // Smithy crafting / barracks training / mining (req §7.2, §7.3, §13).
  // Walk to the building's tile, then "enter" by setting Unit.insideBuildingId.
  // While inside, the building's per-step logic ticks craft/train progress and
  // posts the result (equipment counters, kind transitions, ore yields).
  | {
      type: "operate";
      buildingId: number;
      mode: OperateMode;
      phase: "toBuilding" | "inside" | "toStore" | "storing";
      path: TileCoord[];
      node: number;
      storeId: number | null; // used by mine operators while depositing
    };

export interface Unit {
  id: number;
  kind: UnitKind;
  x: number; // tile-space column (fractional while moving)
  y: number; // tile-space row
  hp: number;
  carrying: Inventory;
  // Mirror of Building.occupantId. Set while phase === "inside"; null otherwise.
  // Cached on the unit so the renderer can hide units that are inside a building
  // without scanning every building each frame.
  insideBuildingId: number | null;
  order: Order;
}

// Carry capacity by kind (req §6.1). Captains carry only equipment (2 slots);
// since equipment isn't carried as a resource yet (M5), they are treated as 0
// here. Worker/Soldier share the resource carry cap.
export function carryCap(unit: Unit): number {
  if (unit.kind === "captain") return 0;
  return WORKER_CARRY_CAP;
}

export function maxHp(kind: UnitKind): number {
  return UNIT_MAX_HP[kind];
}

export function makeWorker(id: number, x: number, y: number): Unit {
  return {
    id,
    kind: "worker",
    x,
    y,
    hp: UNIT_MAX_HP.worker,
    carrying: {},
    insideBuildingId: null,
    order: { type: "idle" },
  };
}
