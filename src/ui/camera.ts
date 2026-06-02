// Camera + view data (req §4.4). The camera and selection are *view* state,
// not simulation state: they are not saved and never fed into update().
// Coordinates are in CSS pixels (world space). The board is a pointy-top hex
// grid; pixel ↔ hex math lives in src/game/hex.ts.

import { HEX_SIZE, MAP_HEIGHT, MAP_WIDTH } from "../config/index.js";
import {
  HEX_HEIGHT,
  HEX_HORIZ_SPACING,
  HEX_VERT_SPACING,
  HEX_WIDTH,
  hexToPixel,
  pixelToHex,
} from "../game/hex.js";
import type { TileCoord } from "../game/map.js";

export interface Camera {
  x: number; // world px at the left edge of the viewport
  y: number; // world px at the top edge of the viewport
}

export interface DragBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Placement-mode preview (req §7.1). While the player is choosing a tile for a
// new building, the ghost shows where it would land and whether it's a legal
// spot (green = valid, red = invalid).
export interface PlacementGhost {
  tx: number;
  ty: number;
  valid: boolean;
}

export interface View {
  camera: Camera;
  selection: number[];
  selectedBuildings: number[];
  dragBox: DragBox | null; // screen-space, only while drag-selecting
  placement: PlacementGhost | null;
  hoveredUnitId: number | null;
  hoveredBuildingId: number | null;
  // Wood remaining on the hovered forest tile (req §12); null when the cursor
  // isn't over a forest (or is over a unit, which takes tooltip precedence).
  hoveredForestWood: number | null;
  mouseScreenX: number;
  mouseScreenY: number;
}

// World pixel bounds. The +0.5 width adjustment accounts for the rightward
// shift of odd rows (their right-most hex extends half a width past the
// even-row right edge). The vertical math comes from the row spacing plus the
// full height of the last row's hex.
export const WORLD_PX_WIDTH = MAP_WIDTH * HEX_HORIZ_SPACING + 0.5 * HEX_HORIZ_SPACING;
export const WORLD_PX_HEIGHT = (MAP_HEIGHT - 1) * HEX_VERT_SPACING + HEX_HEIGHT;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Keep the camera within the bounded map (req §4.1: no scrolling beyond edges).
export function clampCamera(cam: Camera, viewW: number, viewH: number): Camera {
  const maxX = Math.max(0, WORLD_PX_WIDTH - viewW);
  const maxY = Math.max(0, WORLD_PX_HEIGHT - viewH);
  return { x: clamp(cam.x, 0, maxX), y: clamp(cam.y, 0, maxY) };
}

export function centerOnTile(
  tile: TileCoord,
  viewW: number,
  viewH: number,
): Camera {
  const { px, py } = hexToPixel(tile.x, tile.y);
  return clampCamera(
    { x: px - viewW / 2, y: py - viewH / 2 },
    viewW,
    viewH,
  );
}

// Convert a screen-space pixel (relative to the canvas top-left) to a hex
// coordinate. Inverse of hexToPixel + camera offset.
export function screenToHex(cam: Camera, sx: number, sy: number): TileCoord {
  return pixelToHex(sx + cam.x, sy + cam.y);
}

// Re-export the hex pixel geometry constants for consumers that need them
// alongside the camera (renderer, tests).
export { HEX_HEIGHT, HEX_HORIZ_SPACING, HEX_VERT_SPACING, HEX_WIDTH, HEX_SIZE };
