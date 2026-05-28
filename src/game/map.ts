// Tile map + procedural generation (req §4). The map is plain data (row-major
// tile array) so it serializes with the rest of the state. Generation is driven
// by the seeded RNG (req §2.6) so a given seed always yields the same world.

import {
  FOREST_WOOD_MAX,
  HAMLET_CLEARING_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TERRAIN_TARGET,
} from "../config/index.js";
import { rngInt } from "./rng.js";

// "stump" is a depleted forest tile: walkable, no more wood, and (from M4)
// regrows to forest at spring (req §4.2, §12).
export type TileType = "grass" | "forest" | "water" | "mountain" | "stump";

// Mine type assigned to a mountain tile the first time it is mined (req §13.1).
export type MineType = "stone" | "iron" | "gold";

export interface TileCoord {
  x: number;
  y: number;
}

export interface GameMap {
  width: number;
  height: number;
  tiles: TileType[]; // row-major, length = width * height
  // Per-tile mutable gathering state, keyed by tile index. Sparse: a missing
  // forest entry means "full" (FOREST_WOOD_MAX); a missing mountain entry means
  // "type not yet rolled". Kept out of `tiles` so depletion/typing serialize
  // without bloating the terrain array.
  forestWood: Record<number, number>;
  mineType: Record<number, MineType>;
}

export const HAMLET_CENTER: TileCoord = {
  x: Math.floor(MAP_WIDTH / 2),
  y: Math.floor(MAP_HEIGHT / 2),
};

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function tileAt(map: GameMap, x: number, y: number): TileType {
  return map.tiles[y * map.width + x];
}

// Water is the only impassable terrain (req §4.2). Buildings will also block
// tiles in later milestones; that check belongs here when they exist.
export function isWalkable(map: GameMap, x: number, y: number): boolean {
  return inBounds(map, x, y) && tileAt(map, x, y) !== "water";
}

export function countTiles(map: GameMap, type: TileType): number {
  let c = 0;
  for (const t of map.tiles) if (t === type) c++;
  return c;
}

// Wood left on a forest tile; a missing entry means the tile is full (req §12).
export function forestRemaining(map: GameMap, idx: number): number {
  return map.forestWood[idx] ?? FOREST_WOOD_MAX;
}

// A land tile adjacent (4-way) to at least one water tile can fish (req §14).
export function isWaterAdjacent(map: GameMap, x: number, y: number): boolean {
  for (const [dx, dy] of NEIGHBORS4) {
    if (inBounds(map, x + dx, y + dy) && tileAt(map, x + dx, y + dy) === "water")
      return true;
  }
  return false;
}

function inClearing(x: number, y: number, radius: number): boolean {
  return (
    Math.abs(x - HAMLET_CENTER.x) <= radius &&
    Math.abs(y - HAMLET_CENTER.y) <= radius
  );
}

const NEIGHBORS4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Grow a connected blob of `type` over grass tiles starting near (sx, sy).
// The hamlet clearing acts as a barrier (skipped), so it always stays grass.
function growBlob(
  tiles: TileType[],
  type: TileType,
  sx: number,
  sy: number,
  targetSize: number,
  rngState: number,
): { rngState: number; placed: number } {
  const frontier: TileCoord[] = [{ x: sx, y: sy }];
  const seen = new Set<number>();
  let placed = 0;
  let rng = rngState;

  while (frontier.length > 0 && placed < targetSize) {
    let pick: number;
    [rng, pick] = rngInt(rng, 0, frontier.length - 1);
    const cell = frontier.splice(pick, 1)[0];
    if (cell.x < 0 || cell.y < 0 || cell.x >= MAP_WIDTH || cell.y >= MAP_HEIGHT)
      continue;
    const idx = cell.y * MAP_WIDTH + cell.x;
    if (seen.has(idx)) continue;
    seen.add(idx);
    if (inClearing(cell.x, cell.y, HAMLET_CLEARING_RADIUS)) continue;
    if (tiles[idx] !== "grass") continue;

    tiles[idx] = type;
    placed++;
    for (const [dx, dy] of NEIGHBORS4) {
      frontier.push({ x: cell.x + dx, y: cell.y + dy });
    }
  }
  return { rngState: rng, placed };
}

function scatter(
  tiles: TileType[],
  type: TileType,
  targetCount: number,
  minBlob: number,
  maxBlob: number,
  startCount: number,
  rngState: number,
): { rngState: number; count: number } {
  let rng = rngState;
  let count = startCount;
  let attempts = 0;
  while (count < targetCount && attempts < 5000) {
    attempts++;
    let sx: number, sy: number, size: number;
    [rng, sx] = rngInt(rng, 0, MAP_WIDTH - 1);
    [rng, sy] = rngInt(rng, 0, MAP_HEIGHT - 1);
    if (inClearing(sx, sy, HAMLET_CLEARING_RADIUS)) continue;
    if (tiles[sy * MAP_WIDTH + sx] !== "grass") continue;
    [rng, size] = rngInt(rng, minBlob, maxBlob);
    const res = growBlob(tiles, type, sx, sy, size, rng);
    rng = res.rngState;
    count += res.placed;
  }
  return { rngState: rng, count };
}

export function generateMap(rngState: number): {
  map: GameMap;
  rngState: number;
} {
  const n = MAP_WIDTH * MAP_HEIGHT;
  const tiles: TileType[] = Array.from({ length: n }, () => "grass" as TileType);
  let rng = rngState;

  // Guarantee starting access to every gathering terrain just outside the
  // hamlet clearing (req §4.3: reasonable access from the start position).
  const r = HAMLET_CLEARING_RADIUS;
  const seeds = [
    { type: "forest" as const, x: HAMLET_CENTER.x - (r + 1), y: HAMLET_CENTER.y, size: 14 },
    { type: "mountain" as const, x: HAMLET_CENTER.x + (r + 1), y: HAMLET_CENTER.y, size: 10 },
    { type: "water" as const, x: HAMLET_CENTER.x, y: HAMLET_CENTER.y - (r + 1), size: 10 },
  ];
  const seeded = { forest: 0, water: 0, mountain: 0 };
  for (const s of seeds) {
    const res = growBlob(tiles, s.type, s.x, s.y, s.size, rng);
    rng = res.rngState;
    seeded[s.type] += res.placed;
  }

  // Fill the rest to target coverage. Forest and mountain first so water (the
  // only impassable terrain) cannot wall off large grass regions.
  let res = scatter(tiles, "forest", Math.round(TERRAIN_TARGET.forest * n), 8, 20, seeded.forest, rng);
  rng = res.rngState;
  res = scatter(tiles, "mountain", Math.round(TERRAIN_TARGET.mountain * n), 6, 14, seeded.mountain, rng);
  rng = res.rngState;
  res = scatter(tiles, "water", Math.round(TERRAIN_TARGET.water * n), 5, 12, seeded.water, rng);
  rng = res.rngState;

  return {
    map: { width: MAP_WIDTH, height: MAP_HEIGHT, tiles, forestWood: {}, mineType: {} },
    rngState: rng,
  };
}
