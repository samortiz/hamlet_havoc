// Resources (req §8). Plain string-keyed tallies; the global pool and each
// unit's carried inventory share this type. Values are the trade worth used by
// the town/tax systems (M5/M6); M2 only needs the keys and the pool helpers.

export const RESOURCE_TYPES = [
  "hay",
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
  hay: 1,
  wheat: 2,
  wood: 3,
  stone: 4,
  meat: 5,
  iron: 5,
  gold: 10,
  diamond: 50,
};

export type ResourcePool = Record<ResourceType, number>;
// A unit carries a subset, so its inventory is partial.
export type Inventory = Partial<Record<ResourceType, number>>;

export function emptyPool(): ResourcePool {
  return { hay: 0, wheat: 0, wood: 0, stone: 0, meat: 0, iron: 0, gold: 0, diamond: 0 };
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
