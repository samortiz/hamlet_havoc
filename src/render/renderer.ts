// Render layer (req §2.2). Reads GameState + view and draws the world to the
// canvas; never mutates state. Terrain is culled to the viewport (req §2.9).

import { COLORS, MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "../config/index.js";
import { tileAt, type TileType } from "../game/map.js";
import type { GameState } from "../game/state.js";
import type { View } from "../ui/camera.js";

const TERRAIN_COLOR: Record<TileType, string> = {
  grass: COLORS.terrainGrass,
  forest: COLORS.terrainForest,
  water: COLORS.terrainWater,
  mountain: COLORS.terrainMountain,
};

export interface Renderer {
  render: (state: GameState, view: View) => void;
  resize: () => void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  const c = ctx;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }

  function render(state: GameState, view: View): void {
    const dpr = window.devicePixelRatio || 1;
    const viewW = canvas.width / dpr;
    const viewH = canvas.height / dpr;
    const cam = view.camera;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, viewW, viewH);

    // Visible tile range (cull to viewport, req §2.9).
    const minX = Math.max(0, Math.floor(cam.x / TILE_SIZE));
    const minY = Math.max(0, Math.floor(cam.y / TILE_SIZE));
    const maxX = Math.min(MAP_WIDTH - 1, Math.floor((cam.x + viewW) / TILE_SIZE));
    const maxY = Math.min(MAP_HEIGHT - 1, Math.floor((cam.y + viewH) / TILE_SIZE));

    c.save();
    c.translate(-cam.x, -cam.y);

    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        c.fillStyle = TERRAIN_COLOR[tileAt(state.map, tx, ty)];
        c.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }

    c.strokeStyle = COLORS.gridLine;
    c.lineWidth = 1;
    c.beginPath();
    for (let tx = minX; tx <= maxX + 1; tx++) {
      c.moveTo(tx * TILE_SIZE, minY * TILE_SIZE);
      c.lineTo(tx * TILE_SIZE, (maxY + 1) * TILE_SIZE);
    }
    for (let ty = minY; ty <= maxY + 1; ty++) {
      c.moveTo(minX * TILE_SIZE, ty * TILE_SIZE);
      c.lineTo((maxX + 1) * TILE_SIZE, ty * TILE_SIZE);
    }
    c.stroke();

    const selected = new Set(view.selection);
    const radius = TILE_SIZE * 0.35;
    for (const u of Object.values(state.units)) {
      const cx = (u.x + 0.5) * TILE_SIZE;
      const cy = (u.y + 0.5) * TILE_SIZE;
      c.beginPath();
      c.arc(cx, cy, radius, 0, Math.PI * 2);
      c.fillStyle = COLORS.worker;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = COLORS.unitOutline;
      c.stroke();
      if (selected.has(u.id)) {
        c.beginPath();
        c.arc(cx, cy, radius + 4, 0, Math.PI * 2);
        c.strokeStyle = COLORS.selectionRing;
        c.lineWidth = 2;
        c.stroke();
      }
    }

    c.restore();

    // Drag-select rectangle (screen space).
    if (view.dragBox) {
      const b = view.dragBox;
      c.fillStyle = COLORS.dragBox;
      c.fillRect(b.x, b.y, b.w, b.h);
      c.strokeStyle = COLORS.dragBoxBorder;
      c.lineWidth = 1;
      c.strokeRect(b.x, b.y, b.w, b.h);
    }
  }

  return { render, resize };
}
