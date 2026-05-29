// Commands are the only way input influences the simulation (req §2.6). The
// input layer produces Commands; update() consumes them and turns them into unit
// orders. Each command carries the units it applies to and a target.
//
// Note: pause is a game-loop concern, not a Command — it stops update() from
// being called at all rather than mutating simulation state.

import type { BuildingKind, CraftItem, TrainTarget } from "./buildings.js";
import type { Inventory, ResourceType } from "./resources.js";
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
  // Resume construction on an under-construction building whose builders were
  // interrupted (reassigned, cancelled, etc.). No extra cost — the build cost
  // was already paid on placement (req §7.1).
  | { type: "resumeBuild"; unitIds: number[]; buildingId: number }
  // Demolish a building immediately. No cost refund (req §7.1).
  | { type: "demolish"; buildingId: number }
  // Send a worker into a smithy to craft the given item (req §7.2). The smithy
  // loops on the same item until ordered out or materials run out.
  | { type: "craft"; unitIds: number[]; buildingId: number; item: CraftItem }
  // Send a unit into a barracks to train (req §7.3). The trainee promotes one
  // rank when 1 season of training completes; gated by barracks housing.
  | { type: "train"; unitIds: number[]; buildingId: number; toKind: TrainTarget }
  // Tell the Main Hall to raise a new worker (T5). Free but slow
  // (WORKER_SPAWN_TICKS); gated by worker housing (§7.4). No-op if the hall is
  // already producing one or housing is full.
  | { type: "spawnWorker"; buildingId: number }
  // Attack an enemy (req §6.5, §17). The units walk adjacent and fight until the
  // target dies or the order is cancelled.
  | { type: "attack"; unitIds: number[]; targetEnemyId: number }
  // Equip/unequip a sword or shield on the selected units (req §6.4). Instant —
  // pulls from / returns to the global equipment pool; not an order.
  | { type: "equip"; unitIds: number[]; item: CraftItem; equip: boolean }
  // Travel to the town and trade (req §18). `sell`/`buy` are resource amounts,
  // `buyHorse` requests a mount; the transaction resolves on arrival against the
  // unit's carried inventory at the resources' listed values. This is the quick
  // automatic path (the "Sell at Town" / "Buy Horse" shortcuts); the interactive
  // town interface below uses `townStore` / `townTrade` on a unit already there.
  | {
      type: "trade";
      unitIds: number[];
      sell: Inventory;
      buy: Inventory;
      buyHorse: boolean;
    }
  // Town interface (req §18): move `amount` of one resource between the unit's
  // inventory and town storage. `toStorage` true = unit → town, false = town →
  // unit. Free (no shopkeeper). Requires the unit be standing at the town tile.
  | {
      type: "townStore";
      unitId: number;
      resource: ResourceType;
      amount: number;
      toStorage: boolean;
    }
  // Hall/storage interface (T9): move `amount` of one resource between the unit's
  // inventory and the hamlet's shared resource pool, via a built storage building
  // the unit stands on or next to. `toStorage` true = unit → pool (bounded by the
  // pool's free space), false = pool → unit (bounded by carry room). Lets the
  // player unload a returning worker or load one up for a town run.
  | {
      type: "hallStore";
      unitId: number;
      buildingId: number;
      resource: ResourceType;
      amount: number;
      toStorage: boolean;
    }
  // Town interface (req §18): buy a `cart` of resources (and optionally a horse)
  // from the marketplace, paying with goods offered from the unit's inventory
  // (`offerUnit`) and/or town storage (`offerStorage`). The shopkeeper accepts
  // only if the offered value ≥ the cart value; any surplus is returned to town
  // storage as change. Requires the unit be standing at the town tile.
  | {
      type: "townTrade";
      unitId: number;
      cart: Inventory;
      buyHorse: boolean;
      offerUnit: Inventory;
      offerStorage: Inventory;
    }
  // Stop whatever order the unit currently has and return to idle. Used to pull
  // a smithy operator out, cancel a build, etc.
  | { type: "cancel"; unitIds: number[] };
