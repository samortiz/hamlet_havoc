// Render layer (req §2.2). Reads GameState + view and draws the hex world to
// the canvas; never mutates state. Tiles are pointy-top hexes (req §4.1);
// the geometry lives in src/game/hex.ts.

import {
  BUILD_TICKS,
  COLORS,
  FISH_TICKS_PER_UNIT,
  HARVEST_TICKS,
  HEX_SIZE,
  MAP_HEIGHT,
  MAP_WIDTH,
  ORE_TICKS_PER_UNIT,
  PLANT_TICKS,
  PLOUGH_TICKS,
  WOOD_TICKS_PER_UNIT,
} from "../config/index.js";
import { isBuilt, type Building, type BuildingKind } from "../game/buildings.js";
import type { FieldStage } from "../game/fields.js";
import {
  hexToPixel,
  pixelToHex,
  HEX_HEIGHT,
  HEX_HORIZ_SPACING,
  HEX_VERT_SPACING,
  HEX_WIDTH,
} from "../game/hex.js";
import { tileAt, type TileType } from "../game/map.js";
import { carriedTotal } from "../game/resources.js";
import type { GameState } from "../game/state.js";
import type { FieldAction, GatherResource, Order } from "../game/units.js";
import type { View } from "../ui/camera.js";
import { buildingSprite, terrainSprite, unitSprite } from "./sprites.js";

const TERRAIN_COLOR: Record<TileType, string> = {
  grass: COLORS.terrainGrass,
  forest: COLORS.terrainForest,
  water: COLORS.terrainWater,
  mountain: COLORS.terrainMountain,
  stump: COLORS.terrainStump,
};

// Ticks one completion of each timed action takes — used to turn a unit's
// accumulated `workTicks` into a 0..1 progress fraction for the on-unit bar
// (req §10.2). Must mirror the durations the sim uses in actions.ts.
const FIELD_TICKS: Record<FieldAction, number> = {
  plough: PLOUGH_TICKS,
  plant: PLANT_TICKS,
  harvest: HARVEST_TICKS,
};
const GATHER_TICKS: Record<GatherResource, number> = {
  wood: WOOD_TICKS_PER_UNIT,
  fish: FISH_TICKS_PER_UNIT,
  ore: ORE_TICKS_PER_UNIT,
};

// Progress (0..1) of the unit's current action while it is actively working,
// or null when there's nothing to show (travelling, idle, building, operating —
// construction shows its own bar on the building). Field actions fill toward
// completion; gathering fills toward the next resource unit.
function unitWorkProgress(order: Order): number | null {
  if (order.type === "field" && order.phase === "working") {
    return Math.min(1, order.workTicks / FIELD_TICKS[order.action]);
  }
  if (order.type === "gather" && order.phase === "working") {
    return Math.min(1, order.workTicks / GATHER_TICKS[order.resource]);
  }
  return null;
}

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

// Kenney sprites are pointy-top hexes with a small "depth" rim at the bottom.
// Drawing them at exactly HEX_WIDTH × HEX_HEIGHT lines the top vertex up with
// the hex outline; the depth rim spills ~5% below into the next row, which
// gives the board a subtle 3D feel as long as we paint rows top-to-bottom.
const SPRITE_DRAW_W = HEX_WIDTH;
const SPRITE_DRAW_H = HEX_HEIGHT;

export interface Renderer {
  render: (state: GameState, view: View) => void;
  resize: () => void;
}

// Pre-compute the 6 vertex offsets for a pointy-top hex (apothem on the
// horizontal axis). Indices go clockwise from the bottom-right vertex.
const HEX_VERTEX_OFFSETS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30); // -30° offset = pointy-top
    out.push([Math.cos(angle), Math.sin(angle)]);
  }
  return out;
})();

function tracePath(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const [dx, dy] = HEX_VERTEX_OFFSETS[i];
    const x = cx + dx * size;
    const y = cy + dy * size;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
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

  function fillHex(cx: number, cy: number, size: number, color: string): void {
    tracePath(c, cx, cy, size);
    c.fillStyle = color;
    c.fill();
  }

  function strokeHex(cx: number, cy: number, size: number, color: string, lineWidth = 1): void {
    tracePath(c, cx, cy, size);
    c.strokeStyle = color;
    c.lineWidth = lineWidth;
    c.stroke();
  }

  // Small action progress bar centred at (px) with its top at `topY`.
  function drawProgressBar(px: number, topY: number, frac: number): void {
    const w = HEX_SIZE * 0.8;
    const h = 4;
    const x = px - w / 2;
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.fillRect(x - 1, topY - 1, w + 2, h + 2);
    c.fillStyle = COLORS.gold;
    c.fillRect(x, topY, w * frac, h);
  }

  function drawSpriteAt(img: HTMLImageElement, px: number, py: number): void {
    c.drawImage(
      img,
      px - SPRITE_DRAW_W / 2,
      py - SPRITE_DRAW_H / 2,
      SPRITE_DRAW_W,
      SPRITE_DRAW_H,
    );
  }

  function drawBuilding(b: Building): void {
    const built = isBuilt(b);
    const { px, py } = hexToPixel(b.x, b.y);
    const innerSize = HEX_SIZE * 0.72;

    if (!built) {
      // Under-construction: dashed outline + progress bar (req §7.1). Drawn
      // over the existing terrain so the player can see what's being raised.
      c.globalAlpha = 0.35;
      fillHex(px, py, innerSize, COLORS.buildingOther);
      c.globalAlpha = 1;
      c.setLineDash([3, 2]);
      strokeHex(px, py, innerSize, COLORS.gold, 2);
      c.setLineDash([]);
      const pct = b.progress / BUILD_TICKS[b.kind];
      const barW = innerSize * 1.4;
      c.fillStyle = COLORS.gold;
      c.fillRect(px - barW / 2, py + innerSize * 0.7, barW * pct, 3);
      return;
    }

    const sprite = buildingSprite(b.kind);
    if (sprite) {
      drawSpriteAt(sprite, px, py);
    } else {
      // Fallback while the sprite is still decoding: colored hex + letter.
      fillHex(px, py, innerSize, BUILDING_COLOR[b.kind]);
      strokeHex(px, py, innerSize, COLORS.buildingOutline, 2);
      c.fillStyle = COLORS.buildingLabel;
      c.font = `bold ${Math.round(HEX_SIZE * 0.7)}px system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(BUILDING_LABEL[b.kind], px, py);
    }

    // HP bar shown only when damaged (req §7.1: repair flow).
    if (b.hp < b.maxHp) {
      const hpW = innerSize * 1.4;
      const hpX = px - hpW / 2;
      const hpY = py - innerSize - 5;
      c.fillStyle = "#5c2018";
      c.fillRect(hpX, hpY, hpW, 3);
      c.fillStyle = "#7ea854";
      c.fillRect(hpX, hpY, hpW * (b.hp / b.maxHp), 3);
    }

    // Smithy/barracks craft/train progress while occupied — small status pip.
    if (b.kind === "smithy" && b.craftItem) {
      c.fillStyle = COLORS.carryCue;
      c.beginPath();
      c.arc(px + innerSize * 0.6, py - innerSize * 0.6, 3, 0, Math.PI * 2);
      c.fill();
    }
    if (b.kind === "barracks" && b.trainTo) {
      c.fillStyle = COLORS.gold;
      c.beginPath();
      c.arc(px + innerSize * 0.6, py - innerSize * 0.6, 3, 0, Math.PI * 2);
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

    // Visible hex range: sample the viewport corners, expand by one hex
    // margin to be safe (req §2.9 culling).
    const corners = [
      pixelToHex(cam.x, cam.y),
      pixelToHex(cam.x + viewW, cam.y),
      pixelToHex(cam.x, cam.y + viewH),
      pixelToHex(cam.x + viewW, cam.y + viewH),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const k of corners) {
      if (k.x < minX) minX = k.x;
      if (k.x > maxX) maxX = k.x;
      if (k.y < minY) minY = k.y;
      if (k.y > maxY) maxY = k.y;
    }
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(MAP_WIDTH - 1, maxX + 1);
    maxY = Math.min(MAP_HEIGHT - 1, maxY + 1);

    c.save();
    c.translate(-cam.x, -cam.y);

    // Terrain hexes. Top-to-bottom so each sprite's bottom "depth" rim sits
    // on top of the row below — that's what gives the board a subtle 3D feel.
    // Sprite lookup falls back to a flat colour fill while images are still
    // decoding (and permanently for water, which the pack doesn't ship).
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const t = tileAt(state.map, tx, ty);
        const { px, py } = hexToPixel(tx, ty);
        const sprite = terrainSprite(t);
        if (sprite) {
          drawSpriteAt(sprite, px, py);
        } else {
          fillHex(px, py, HEX_SIZE, TERRAIN_COLOR[t]);
        }
      }
    }

    // Fields (tile features painted as a slightly inset hex over their tile).
    for (const f of Object.values(state.fields)) {
      const { px, py } = hexToPixel(f.x, f.y);
      fillHex(px, py, HEX_SIZE * 0.85, FIELD_COLOR[f.stage]);
    }

    // Buildings.
    const selectedBuildings = new Set(view.selectedBuildings ?? []);
    for (const b of Object.values(state.buildings)) {
      drawBuilding(b);
      if (selectedBuildings.has(b.id)) {
        const { px, py } = hexToPixel(b.x, b.y);
        strokeHex(px, py, HEX_SIZE * 0.8, COLORS.selectionRing, 2);
      }
    }

    // Placement ghost preview (req §7.1, while in placement mode).
    const ghost = view.placement;
    if (ghost) {
      const { px, py } = hexToPixel(ghost.tx, ghost.ty);
      const ghostColor = ghost.valid ? COLORS.gold : "#b04030";
      c.globalAlpha = 0.55;
      fillHex(px, py, HEX_SIZE * 0.78, ghostColor);
      c.globalAlpha = 1;
      strokeHex(px, py, HEX_SIZE * 0.78, ghostColor, 2);
    }

    // Units. A character sprite is drawn aspect-preserved with its feet near
    // the tile centre; kinds without a sprite (and sprites still decoding) fall
    // back to the procedural colour circle.
    const selected = new Set(view.selection);
    const unitRadius = HEX_SIZE * 0.5;
    const SPRITE_TARGET_H = HEX_SIZE * 1.05; // ~42px tall — fits inside the ~80px hex
    const FOOT_OFFSET = HEX_SIZE * 0.25; // how far below tile centre the feet sit
    for (const u of Object.values(state.units)) {
      if (u.insideBuildingId !== null) continue; // hidden while operating
      const { px, py } = hexToPixel(u.x, u.y);
      const sprite = unitSprite(u.kind);

      // headY = top of whatever glyph we draw, for placing the carry cue.
      let headY: number;
      if (sprite) {
        const h = SPRITE_TARGET_H;
        const w = (sprite.naturalWidth / sprite.naturalHeight) * h;
        const top = py + FOOT_OFFSET - h;
        c.drawImage(sprite, px - w / 2, top, w, h);
        headY = top;
      } else {
        c.beginPath();
        c.arc(px, py, unitRadius, 0, Math.PI * 2);
        c.fillStyle = u.kind === "captain" ? "#d4af37" : COLORS.worker;
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = COLORS.unitOutline;
        c.stroke();
        headY = py - unitRadius;
      }

      if (carriedTotal(u.carrying) > 0) {
        c.beginPath();
        c.arc(px, headY, unitRadius * 0.35, 0, Math.PI * 2);
        c.fillStyle = COLORS.carryCue;
        c.fill();
      }
      // Action progress bar above the head (ploughing/planting/harvesting,
      // gathering wood/fish/ore). Construction shows its own bar on the building.
      const progress = unitWorkProgress(u.order);
      if (progress !== null) {
        drawProgressBar(px, headY - 10, progress);
      }
      if (selected.has(u.id)) {
        c.beginPath();
        c.ellipse(px, py + FOOT_OFFSET * 0.5, unitRadius + 4, unitRadius * 0.55, 0, 0, Math.PI * 2);
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

// Re-export the hex geometry constants for any callers that need them outside
// the render module (currently just the test harness).
export { HEX_HEIGHT, HEX_HORIZ_SPACING, HEX_VERT_SPACING, HEX_WIDTH };
