// Buildings (req §7). M2 needs only the starting structures (Main Hall + Houses)
// as storage providers and resource drop-off points; the full construction
// system (placement, all types, repair/demolish, smithy/barracks) arrives in M3.
// Plain id-based data like every other entity. Footprints are a single tile in
// M2 and do not block movement yet — dynamic walkability is an M3 concern (§6.5).

import { BUILDING_HP, BUILDING_STORAGE } from "../config/index.js";

export type BuildingKind =
  | "mainHall"
  | "house"
  | "barn"
  | "smithy"
  | "barracks"
  | "mine";

export interface Building {
  id: number;
  kind: BuildingKind;
  x: number; // tile
  y: number;
  hp: number;
}

export function makeBuilding(
  id: number,
  kind: BuildingKind,
  x: number,
  y: number,
): Building {
  return { id, kind, x, y, hp: BUILDING_HP[kind] };
}

export function buildingStorage(kind: BuildingKind): number {
  return BUILDING_STORAGE[kind];
}

export function isStorage(b: Building): boolean {
  return BUILDING_STORAGE[b.kind] > 0;
}

// Total pooled storage limit = sum of every building's storage (req §7).
export function storageCapacity(buildings: Record<number, Building>): number {
  let cap = 0;
  for (const b of Object.values(buildings)) cap += BUILDING_STORAGE[b.kind];
  return cap;
}

// Nearest storage building to a point, by squared distance (req §8.1).
export function nearestStorage(
  buildings: Record<number, Building>,
  x: number,
  y: number,
): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of Object.values(buildings)) {
    if (BUILDING_STORAGE[b.kind] <= 0) continue;
    const d = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}
