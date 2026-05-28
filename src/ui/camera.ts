// Camera + view data (req §4.4). The camera and selection are *view* state, not
// simulation state: they are not saved and never fed into update(). Coordinates
// are in CSS pixels (world space, 1:1 with tiles*TILE_SIZE — no zoom in M1).

import { MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "../config/index.js";
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

export interface View {
  camera: Camera;
  selection: number[];
  dragBox: DragBox | null; // screen-space, only while drag-selecting
}

export const WORLD_PX_WIDTH = MAP_WIDTH * TILE_SIZE;
export const WORLD_PX_HEIGHT = MAP_HEIGHT * TILE_SIZE;

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
  return clampCamera(
    {
      x: (tile.x + 0.5) * TILE_SIZE - viewW / 2,
      y: (tile.y + 0.5) * TILE_SIZE - viewH / 2,
    },
    viewW,
    viewH,
  );
}

export function screenToTile(cam: Camera, sx: number, sy: number): TileCoord {
  return {
    x: Math.floor((sx + cam.x) / TILE_SIZE),
    y: Math.floor((sy + cam.y) / TILE_SIZE),
  };
}
