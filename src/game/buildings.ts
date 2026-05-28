// Buildings (req §7). M3 brings the full construction system: every building
// is placed via a `build` command, accumulates progress while workers build it,
// and can be repaired or demolished. Smithy and barracks also carry per-step
// state (craft progress, training progress) for the workflows in §7.2/§7.3.
// Plain id-based data like every other entity (req §2.6) — no class instances,
// no cross-entity object references; all relationships are integer ids.

import {
  BUILD_TICKS,
  BUILDING_COST,
  BUILDING_HP,
  BUILDING_STORAGE,
  type BuildCost,
} from "../config/index.js";

export type BuildingKind =
  | "mainHall"
  | "house"
  | "barn"
  | "smithy"
  | "barracks"
  | "mine";

// What the smithy is currently crafting; null = idle (§7.2).
export type CraftItem = "sword" | "shield";

// What a barracks trainee is becoming; null = not training (§7.3).
export type TrainTarget = "soldier" | "captain";

export interface Building {
  id: number;
  kind: BuildingKind;
  x: number; // tile
  y: number;
  hp: number;
  maxHp: number;
  // Construction progress in ticks (req §7). `isBuilt` is true once this
  // reaches BUILD_TICKS[kind]; until then the building doesn't provide its
  // effect (storage, smithy production, barracks training, mine yields).
  progress: number;
  // Unit currently inside the building (smithy operator / barracks trainee /
  // mine operator). Null when empty. The unit's `insideBuildingId` mirrors
  // this; both sides must stay in sync.
  occupantId: number | null;
  // Smithy: item being crafted + accumulated craft ticks. The smithy ticks
  // craftProgress while it has an occupant, deducts cost + increments
  // equipment when the item completes, then loops on the same item until the
  // operator is ordered out or materials run out (§7.2).
  craftItem: CraftItem | null;
  craftProgress: number;
  // Barracks: who is training, into what, and how far along (§7.3).
  trainTo: TrainTarget | null;
  trainProgress: number;
}

export function makeBuilding(
  id: number,
  kind: BuildingKind,
  x: number,
  y: number,
  opts?: { built?: boolean },
): Building {
  const maxHp = BUILDING_HP[kind];
  const built = opts?.built ?? false;
  return {
    id,
    kind,
    x,
    y,
    hp: maxHp,
    maxHp,
    progress: built ? BUILD_TICKS[kind] : 0,
    occupantId: null,
    craftItem: null,
    craftProgress: 0,
    trainTo: null,
    trainProgress: 0,
  };
}

export function isBuilt(b: Building): boolean {
  return b.progress >= BUILD_TICKS[b.kind];
}

export function buildingCost(kind: BuildingKind): BuildCost {
  return BUILDING_COST[kind];
}

export function buildingStorage(kind: BuildingKind): number {
  return BUILDING_STORAGE[kind];
}

export function isStorage(b: Building): boolean {
  return BUILDING_STORAGE[b.kind] > 0 && isBuilt(b);
}

// Total pooled storage limit = sum of every *completed* building's storage
// (req §7). Under-construction buildings do not provide storage yet.
export function storageCapacity(buildings: Record<number, Building>): number {
  let cap = 0;
  for (const b of Object.values(buildings)) {
    if (isBuilt(b)) cap += BUILDING_STORAGE[b.kind];
  }
  return cap;
}

// Nearest completed storage building to a point, by squared distance (req §8.1).
export function nearestStorage(
  buildings: Record<number, Building>,
  x: number,
  y: number,
): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of Object.values(buildings)) {
    if (!isStorage(b)) continue;
    const d = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

// Look up the building (if any) sitting on a tile. Used by placement-validity
// rules (no overlap) and the right-click target classifier.
export function buildingAt(
  buildings: Record<number, Building>,
  x: number,
  y: number,
): Building | undefined {
  for (const b of Object.values(buildings)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
}

// Repair cost scales linearly with HP missing (req §7.1: "cost scales with the
// HP missing"). Returns the cost to bring this building to full HP right now.
export function repairCost(b: Building): BuildCost {
  const ratio = b.maxHp > 0 ? (b.maxHp - b.hp) / b.maxHp : 0;
  const out: BuildCost = {};
  const base = BUILDING_COST[b.kind];
  for (const k of Object.keys(base) as (keyof BuildCost)[]) {
    out[k] = Math.ceil((base[k] ?? 0) * ratio);
  }
  return out;
}
