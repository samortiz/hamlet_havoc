// Unit entities (req §6). Plain data, referenced by integer id from GameState.
// Position is in tile-space (fractional while moving). Orders drive behavior via
// a small per-unit state machine (req §6.5). M2 adds the gather/farming orders;
// M3 adds build/operate (construct, repair, smithy craft, barracks train). The
// rest (trade/attack) arrive in later milestones.

import {
  HORSE_CARRY_BONUS,
  UNIT_MAX_HP,
  WORKER_CARRY_CAP,
} from "../config/index.js";
import type { TileCoord } from "./map.js";
import type { Inventory } from "./resources.js";

export type UnitKind = "worker" | "soldier" | "captain";

// What a gather order is harvesting. The work tile differs per resource: wood =
// the forest tile, ore = the mountain tile (with a built mine on it; req §13),
// fish = a land tile adjacent to water.
export type GatherResource = "wood" | "fish" | "ore";

export type FieldAction = "plough" | "plant" | "harvest";

// What an `operate` order does inside the building (req §7.2, §7.3).
// `craftSword`/`craftShield`: smithy production loop.
// `trainSoldier`/`trainCaptain`: barracks promotion of the unit doing the order.
// (Mining is a `gather` order — see GatherResource "ore" — not an operate mode.)
export type OperateMode =
  | "craftSword"
  | "craftShield"
  | "trainSoldier"
  | "trainCaptain";

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
  // Smithy crafting / barracks training (req §7.2, §7.3).
  // Walk to the building's tile, then "enter" by setting Unit.insideBuildingId.
  // While inside, the building's per-step logic ticks craft/train progress and
  // posts the result (equipment counters, kind transitions).
  | {
      type: "operate";
      buildingId: number;
      mode: OperateMode;
      phase: "toBuilding" | "inside" | "toStore" | "storing";
      path: TileCoord[];
      node: number;
      storeId: number | null;
    }
  // Attack an enemy (req §6.5, §17). Walk to a walkable tile adjacent to the
  // target, then hold — the combat pass (combat.ts) applies the once-per-second
  // hits. The order ends (→ idle) when the target dies or becomes unreachable.
  | {
      type: "attack";
      targetId: number; // enemy id
      path: TileCoord[];
      node: number;
    }
  // Travel to the town tile and trade (req §18). `sell`/`buy` are resource
  // amounts and `buyHorse` requests a mount; the transaction resolves against
  // the unit's carried inventory once it reaches town, then the unit goes idle.
  | {
      type: "trade";
      tx: number; // town tile
      ty: number;
      sell: Inventory;
      buy: Inventory;
      buyHorse: boolean;
      phase: "toTown" | "trading";
      path: TileCoord[];
      node: number;
    };

// Equipment a unit currently carries (req §6.4). At most one of each; each
// equipped item occupies one carry slot (see carryCap).
export interface Equipment {
  sword: boolean;
  shield: boolean;
}

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
  // Equipment held by the unit (req §6.4); pulled from the global equipment pool.
  equipped: Equipment;
  // Horse buffer HP (req §9). 0 = no horse. A live horse (horseHp > 0) doubles
  // speed and adds carry; its HP absorbs incoming damage before the unit's own.
  horseHp: number;
  // Ticks until this unit may swing again (req §17.1: 1 attack/sec). Counts down
  // in the combat pass; reset to ATTACK_INTERVAL_TICKS after each hit.
  attackCooldown: number;
  order: Order;
}

export function hasHorse(unit: Unit): boolean {
  return unit.horseHp > 0;
}

export function equippedCount(unit: Unit): number {
  return (unit.equipped.sword ? 1 : 0) + (unit.equipped.shield ? 1 : 0);
}

// Resource carry capacity (req §6.1, §6.4, §9). Captains carry no resources
// (their 2-slot capacity is equipment-only). Worker/Soldier share WORKER_CARRY_CAP;
// each equipped sword/shield occupies one slot, and a live horse adds 5 slots.
export function carryCap(unit: Unit): number {
  if (unit.kind === "captain") return 0;
  const horse = hasHorse(unit) ? HORSE_CARRY_BONUS : 0;
  return Math.max(0, WORKER_CARRY_CAP - equippedCount(unit) + horse);
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
    equipped: { sword: false, shield: false },
    horseHp: 0,
    attackCooldown: 0,
    order: { type: "idle" },
  };
}
