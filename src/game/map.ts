// Tile map + procedural generation (req §4). The board is a **pointy-top
// hexagonal grid** in odd-r offset coordinates; tiles[] stays row-major so
// the storage format is unchanged. All adjacency, distance, and pixel math
// lives in src/game/hex.ts — this module reads from it.
// Generation is driven by the seeded RNG (req §2.6) so a given seed always
// yields the same world.

import {
  FOREST_WOOD_MAX,
  HAMLET_CLEARING_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TERRAIN_TARGET,
} from "../config/index.js";
import { hexDistance, hexNeighbors, hexStep } from "./hex.js";
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

// A land tile hex-adjacent to at least one water tile can fish (req §14).
// "Adjacent" = hex-distance 1, i.e. one of the 6 odd-r neighbors.
export function isWaterAdjacent(map: GameMap, x: number, y: number): boolean {
  for (const n of hexNeighbors(x, y)) {
    if (inBounds(map, n.x, n.y) && tileAt(map, n.x, n.y) === "water") return true;
  }
  return false;
}

// The hamlet starts in a hex-disc of grass (req §4.3). Using hex distance
// keeps the clearing symmetrical on the actual board geometry — a Chebyshev
// square would punch out a diamond shape in hex space.
function inClearing(x: number, y: number, radius: number): boolean {
  return hexDistance({ x, y }, HAMLET_CENTER) <= radius;
}

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
    for (const n of hexNeighbors(cell.x, cell.y)) frontier.push(n);
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
  // hamlet clearing (req §4.3). Pick three cube directions at distance r+1
  // so forest/mountain/water sit at different bearings around the center.
  // Direction indices into CUBE_DIRECTIONS (see hex.ts): 0=E, 2=NW, 5=SE.
  const r = HAMLET_CLEARING_RADIUS + 1;
  const forestSeed = hexStep(HAMLET_CENTER, 3, r); // west
  const mountainSeed = hexStep(HAMLET_CENTER, 0, r); // east
  const waterSeed = hexStep(HAMLET_CENTER, 2, r); // north-east (above)

  const seeds = [
    { type: "forest" as const, ...forestSeed, size: 14 },
    { type: "mountain" as const, ...mountainSeed, size: 10 },
    { type: "water" as const, ...waterSeed, size: 10 },
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
