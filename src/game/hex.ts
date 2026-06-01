// Hex-grid math (req §4.1). Single source of truth for everything geometric
// about the board: 6-neighbor adjacency, hex distance, and the bijection
// between offset-coordinate hexes and world-pixel centers. Pure module with
// no render/ui imports so the sim can use it freely.
//
// Coordinate convention: **pointy-top hexes, odd-r offset coordinates**.
// - (col, row) names a hex in the row-major tiles[] array.
// - Even rows align with the world-x axis; odd rows are offset rightward by
//   half a hex width.
// - The 6 neighbors of (c, r) depend on row parity:
//     even r: (c+1,r) (c-1,r) (c, r-1) (c-1, r-1) (c, r+1) (c-1, r+1)
//     odd  r: (c+1,r) (c-1,r) (c+1, r-1) (c, r-1) (c+1, r+1) (c, r+1)
// All neighbors are at hex-distance 1 (no diagonal cost asymmetry).
//
// References: https://www.redblobgames.com/grids/hexagons/

import { HEX_SIZE } from "../config/index.js";
import type { TileCoord } from "./map.js";

// --- Pixel geometry (pointy-top hex with circumradius HEX_SIZE) ---
export const HEX_WIDTH = Math.sqrt(3) * HEX_SIZE;
export const HEX_HEIGHT = 2 * HEX_SIZE;
export const HEX_HORIZ_SPACING = HEX_WIDTH;
export const HEX_VERT_SPACING = 1.5 * HEX_SIZE;

// --- Neighbor offsets (odd-r) ---
// Indexed by row parity (0 = even, 1 = odd). Each entry is the 6 (dx, dy)
// deltas to reach the 6 hex neighbors from a hex on that row.
const NEIGHBOR_DELTAS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // even row
  [
    [+1, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
    [0, +1],
    [-1, +1],
  ],
  // odd row
  [
    [+1, 0],
    [-1, 0],
    [+1, -1],
    [0, -1],
    [+1, +1],
    [0, +1],
  ],
];

export function hexNeighbors(x: number, y: number): TileCoord[] {
  // Adjacency is defined on whole hexes. A fractional coord (e.g. a unit or
  // enemy caught mid-move) would make `cy % 2` non-integer and index
  // NEIGHBOR_DELTAS out of bounds → a crash on `deltas[i][0]`. Snap to the
  // containing hex so this single source of grid geometry never throws.
  const cx = Math.round(x);
  const cy = Math.round(y);
  const deltas = NEIGHBOR_DELTAS[((cy % 2) + 2) % 2];
  const out: TileCoord[] = new Array(6);
  for (let i = 0; i < 6; i++) {
    out[i] = { x: cx + deltas[i][0], y: cy + deltas[i][1] };
  }
  return out;
}

// --- Axial / cube conversions ---
// We use the odd-r ↔ axial transform from redblobgames.com.
export interface Axial {
  q: number;
  r: number;
}

export function offsetToAxial(c: TileCoord): Axial {
  const q = c.x - (c.y - (c.y & 1)) / 2;
  const r = c.y;
  return { q, r };
}

export function axialToOffset(a: Axial): TileCoord {
  const x = a.q + (a.r - (a.r & 1)) / 2;
  const y = a.r;
  return { x, y };
}

// Cube-coordinate hex distance, expressed against the axial representation
// (s = -q - r is implicit). Returns the integer number of hops between two
// hexes; the same value drives the A* heuristic.
export function hexDistance(a: TileCoord, b: TileCoord): number {
  const aa = offsetToAxial(a);
  const ba = offsetToAxial(b);
  const dq = aa.q - ba.q;
  const dr = aa.r - ba.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

// Round a fractional axial coord to the nearest integer hex. Used by
// pixelToHex after the inverse pixel-to-axial transform produces a fractional
// (q, r). Implements the standard cube-rounding trick.
function axialRound(qf: number, rf: number): Axial {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  let s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  // else s is the worst — we don't need it, since axial is (q, r).
  return { q, r };
}

// --- Pixel ↔ hex ---
// hexToPixel supports fractional offset coords for smooth unit movement
// (a unit at (3.5, 2) lies on the world-pixel midpoint between hexes
// (3, 2) and (4, 2)).
export function hexToPixel(x: number, y: number): { px: number; py: number } {
  // Pointy-top: column step contributes full width; odd rows shift by half a
  // width; row step contributes 1.5 * size. For fractional y we linearly
  // interpolate the row shift so units crossing a row boundary don't snap
  // sideways mid-step.
  const yFloor = Math.floor(y);
  const rowShift = (yFloor & 1) * 0.5 * HEX_WIDTH;
  const nextRowShift = ((yFloor + 1) & 1) * 0.5 * HEX_WIDTH;
  const rowFrac = y - yFloor;
  const shift = rowShift * (1 - rowFrac) + nextRowShift * rowFrac;
  const px = (x + 0.5) * HEX_WIDTH + shift;
  const py = HEX_SIZE + y * HEX_VERT_SPACING;
  return { px, py };
}

export function pixelToHex(px: number, py: number): TileCoord {
  // Inverse of hexToPixel. Solve for (col, row) via axial coords:
  //   q_f = (sqrt(3)/3 * px - 1/3 * py) / size
  //   r_f = (2/3 * py) / size
  // then convert axial → offset and round.
  // Shift origin so a hex at (0, 0) is centered at (HEX_WIDTH/2, HEX_SIZE).
  const x = px - HEX_WIDTH / 2;
  const y = py - HEX_SIZE;
  const qf = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / HEX_SIZE;
  const rf = ((2 / 3) * y) / HEX_SIZE;
  const a = axialRound(qf, rf);
  return axialToOffset(a);
}

// Cube-direction step helpers (used by map generation to seed terrain at a
// fixed hex distance from the hamlet center). Each direction is one of the
// 6 unit cube vectors; `cubeStep(center, dir, count)` returns the hex `count`
// hops in that direction.
export const CUBE_DIRECTIONS: ReadonlyArray<Axial> = [
  { q: +1, r: 0 },
  { q: +1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: +1 },
  { q: 0, r: +1 },
];

export function hexStep(center: TileCoord, dirIdx: number, count: number): TileCoord {
  const c = offsetToAxial(center);
  const d = CUBE_DIRECTIONS[((dirIdx % 6) + 6) % 6];
  return axialToOffset({ q: c.q + d.q * count, r: c.r + d.r * count });
}
