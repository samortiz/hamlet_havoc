// Resources (req §8). Plain string-keyed tallies; the global pool and each
// unit's carried inventory share this type. Values are the trade worth used by
// the town/tax systems.

// Hay is intentionally absent: it is not a stored or tradeable resource (req
// §8/§9). Hay *fields* are a tile feature that only provide horse stabling
// capacity (see `fields.ts`); they produce nothing.
export const RESOURCE_TYPES = [
  "wheat",
  "wood",
  "stone",
  "meat",
  "iron",
  "gold",
  "diamond",
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

// Trade value per unit (req §8).
export const RESOURCE_VALUE: Record<ResourceType, number> = {
  wheat: 2,
  wood: 3,
  stone: 3,
  meat: 4,
  iron: 4,
  gold: 10,
  diamond: 50,
};

export type ResourcePool = Record<ResourceType, number>;
// A unit carries a subset, so its inventory is partial.
export type Inventory = Partial<Record<ResourceType, number>>;

export function emptyPool(): ResourcePool {
  return { wheat: 0, wood: 0, stone: 0, meat: 0, iron: 0, gold: 0, diamond: 0 };
}

export function poolTotal(pool: ResourcePool): number {
  let total = 0;
  for (const t of RESOURCE_TYPES) total += pool[t];
  return total;
}

export function carriedTotal(inv: Inventory): number {
  let total = 0;
  for (const t of RESOURCE_TYPES) total += inv[t] ?? 0;
  return total;
}

// Total trade worth of an inventory at the listed per-resource values (req §8).
// Used by the town marketplace (req §18) to compare an offer against a cart and
// to value sales.
export function inventoryValue(inv: Inventory): number {
  let total = 0;
  for (const t of RESOURCE_TYPES) total += (inv[t] ?? 0) * RESOURCE_VALUE[t];
  return total;
}

// Decompose a surplus trade value into change goods (req §18). Gold (10) covers
// the bulk; the sub-coin remainder is paid in wood (3) and wheat (2), which can
// make any value of 2 or more. Only an indivisible remainder of exactly 1 is
// forfeited (no resource is worth 1). Returns the change as an inventory.
export function makeChange(value: number): Inventory {
  const change: Inventory = {};
  const v = Math.max(0, Math.floor(value));
  const gold = Math.floor(v / RESOURCE_VALUE.gold);
  if (gold > 0) change.gold = gold;
  let r = v % RESOURCE_VALUE.gold; // 0..9 left after whole coins
  // An odd remainder needs one wood (3) to leave an even amount; r === 1 has no
  // wood/wheat representation, so it falls through and is lost.
  if (r % 2 === 1 && r >= 3) {
    change.wood = 1;
    r -= 3;
  }
  if (r >= 2) change.wheat = r / 2;
  return change;
}
