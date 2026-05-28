// Render layer (req §2.2). Reads GameState + view and draws the world to the
// canvas; never mutates state. Terrain is culled to the viewport (req §2.9).

import { COLORS, MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "../config/index.js";
import type { BuildingKind } from "../game/buildings.js";
import type { FieldStage } from "../game/fields.js";
import { tileAt, type TileType } from "../game/map.js";
import { carriedTotal } from "../game/resources.js";
import type { GameState } from "../game/state.js";
import type { View } from "../ui/camera.js";

const TERRAIN_COLOR: Record<TileType, string> = {
  grass: COLORS.terrainGrass,
  forest: COLORS.terrainForest,
  water: COLORS.terrainWater,
  mountain: COLORS.terrainMountain,
  stump: COLORS.terrainStump,
};

const FIELD_COLOR: Record<FieldStage, string> = {
  ploughed: COLORS.fieldPloughed,
  planted: COLORS.fieldPlanted,
  grown: COLORS.fieldGrown,
};

const BUILDING_COLOR: Record<BuildingKind, string> = {
  mainHall: COLORS.buildingMainHall,
  house: COLORS.buildingHouse,
  barn: COLORS.buildingOther,
  smithy: COLORS.buildingOther,
  barracks: COLORS.buildingOther,
  mine: COLORS.buildingOther,
};

const BUILDING_LABEL: Record<BuildingKind, string> = {
  mainHall: "H",
  house: "h",
  barn: "B",
  smithy: "S",
  barracks: "K",
  mine: "M",
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

    // Fields (tile features painted over their grass tile).
    for (const f of Object.values(state.fields)) {
      c.fillStyle = FIELD_COLOR[f.stage];
      c.fillRect(f.x * TILE_SIZE + 1, f.y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    }

    // Buildings (inset square + a single-letter label).
    const pad = 3;
    for (const b of Object.values(state.buildings)) {
      const bx = b.x * TILE_SIZE + pad;
      const by = b.y * TILE_SIZE + pad;
      const size = TILE_SIZE - pad * 2;
      c.fillStyle = BUILDING_COLOR[b.kind];
      c.fillRect(bx, by, size, size);
      c.lineWidth = 2;
      c.strokeStyle = COLORS.buildingOutline;
      c.strokeRect(bx, by, size, size);
      c.fillStyle = COLORS.buildingLabel;
      c.font = `bold ${Math.round(TILE_SIZE * 0.5)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(BUILDING_LABEL[b.kind], (b.x + 0.5) * TILE_SIZE, (b.y + 0.5) * TILE_SIZE);
    }

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
      // Carry cue: a gold pip when the unit is holding resources (req §8.1).
      if (carriedTotal(u.carrying) > 0) {
        c.beginPath();
        c.arc(cx, cy - radius, radius * 0.35, 0, Math.PI * 2);
        c.fillStyle = COLORS.carryCue;
        c.fill();
      }
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
