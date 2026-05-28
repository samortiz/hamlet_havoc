// Render layer (req §2.2). Reads GameState + view and draws the world to the
// canvas; never mutates state. Terrain is culled to the viewport (req §2.9).

import { BUILD_TICKS, COLORS, MAP_HEIGHT, MAP_WIDTH, TILE_SIZE } from "../config/index.js";
import { isBuilt, type Building, type BuildingKind } from "../game/buildings.js";
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
  hayBuilding: COLORS.hayBuilding,
  hayMature: COLORS.hayMature,
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

  function drawBuilding(b: Building): void {
    const built = isBuilt(b);
    const pad = 3;
    const bx = b.x * TILE_SIZE + pad;
    const by = b.y * TILE_SIZE + pad;
    const size = TILE_SIZE - pad * 2;

    if (!built) {
      // Under-construction: dashed outline + progress bar (req §7.1).
      c.fillStyle = COLORS.buildingOther;
      c.globalAlpha = 0.35;
      c.fillRect(bx, by, size, size);
      c.globalAlpha = 1;
      c.setLineDash([3, 2]);
      c.lineWidth = 2;
      c.strokeStyle = COLORS.gold;
      c.strokeRect(bx, by, size, size);
      c.setLineDash([]);
      const pct = b.progress / BUILD_TICKS[b.kind];
      c.fillStyle = COLORS.gold;
      c.fillRect(bx, by + size - 4, Math.max(0, size * pct), 4);
      return;
    }

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

    // HP bar shown only when damaged (req §7.1: repair flow).
    if (b.hp < b.maxHp) {
      const hpW = size;
      c.fillStyle = "#5c2018";
      c.fillRect(bx, by - 4, hpW, 3);
      c.fillStyle = "#7ea854";
      c.fillRect(bx, by - 4, hpW * (b.hp / b.maxHp), 3);
    }

    // Smithy/barracks craft/train progress while occupied — small status pip.
    if (b.kind === "smithy" && b.craftItem) {
      c.fillStyle = COLORS.carryCue;
      c.beginPath();
      c.arc(bx + size - 3, by + 3, 3, 0, Math.PI * 2);
      c.fill();
    }
    if (b.kind === "barracks" && b.trainTo) {
      c.fillStyle = COLORS.gold;
      c.beginPath();
      c.arc(bx + size - 3, by + 3, 3, 0, Math.PI * 2);
      c.fill();
    }
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
    const selectedBuildings = new Set(view.selectedBuildings ?? []);
    for (const b of Object.values(state.buildings)) {
      drawBuilding(b);
      if (selectedBuildings.has(b.id)) {
        const pad = 3;
        c.lineWidth = 2;
        c.strokeStyle = COLORS.selectionRing;
        c.strokeRect(
          b.x * TILE_SIZE + pad - 2,
          b.y * TILE_SIZE + pad - 2,
          TILE_SIZE - pad * 2 + 4,
          TILE_SIZE - pad * 2 + 4,
        );
      }
    }

    // Placement ghost preview (req §7.1, while in placement mode).
    const ghost = view.placement;
    if (ghost) {
      c.globalAlpha = 0.55;
      c.fillStyle = ghost.valid ? COLORS.gold : "#b04030";
      c.fillRect(ghost.tx * TILE_SIZE + 4, ghost.ty * TILE_SIZE + 4, TILE_SIZE - 8, TILE_SIZE - 8);
      c.globalAlpha = 1;
      c.lineWidth = 2;
      c.strokeStyle = ghost.valid ? COLORS.gold : "#b04030";
      c.strokeRect(ghost.tx * TILE_SIZE + 4, ghost.ty * TILE_SIZE + 4, TILE_SIZE - 8, TILE_SIZE - 8);
    }

    const selected = new Set(view.selection);
    const radius = TILE_SIZE * 0.35;
    for (const u of Object.values(state.units)) {
      // Units inside a building are hidden from the map; the building's
      // status pip stands in for them while they work (req §7.2/§7.3).
      if (u.insideBuildingId !== null) continue;
      const cx = (u.x + 0.5) * TILE_SIZE;
      const cy = (u.y + 0.5) * TILE_SIZE;
      c.beginPath();
      c.arc(cx, cy, radius, 0, Math.PI * 2);
      c.fillStyle =
        u.kind === "soldier" ? "#b89678"
        : u.kind === "captain" ? "#d4af37"
        : COLORS.worker;
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
