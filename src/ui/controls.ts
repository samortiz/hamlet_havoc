// Input + selection layer (req §2.6, §4.4, §6.5, §20). Translates raw browser
// events into camera movement, unit/building selection (click / drag-box), and
// commands (move, gather, build, repair, demolish, craft, train).
//
// Selection and camera are view state held here, not in the simulation;
// commands are the only thing handed to the sim. Building selection is single-
// pick: clicking a building tile picks that building; clicking elsewhere or on
// a unit re-routes to the unit-selection path.

import {
  CAMERA_PAN_PX_PER_SEC,
  DRAG_SELECT_THRESHOLD_PX,
  EDGE_SCROLL_MARGIN_PX,
  TILE_SIZE,
} from "../config/index.js";
import { placementValid } from "../game/actions.js";
import { buildingAt, type Building } from "../game/buildings.js";
import type { BuildableKind, Command } from "../game/commands.js";
import { fieldAt } from "../game/fields.js";
import { HAMLET_CENTER, inBounds, tileAt } from "../game/map.js";
import type { GameState } from "../game/state.js";
import {
  centerOnTile,
  clampCamera,
  screenToTile,
  type Camera,
  type DragBox,
  type PlacementGhost,
  type View,
} from "./camera.js";

interface DragState {
  active: boolean;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  moved: boolean;
}

// Keyboard pan (req §4.4, §20): arrows and WASD.
const PAN_KEYS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  KeyA: [-1, 0],
  ArrowRight: [1, 0],
  KeyD: [1, 0],
  ArrowUp: [0, -1],
  KeyW: [0, -1],
  ArrowDown: [0, 1],
  KeyS: [0, 1],
};

// Digit → buildable kind (req §7.1, M3 input). Digit 1 = House, ... 6 = Hay.
const PLACEMENT_KEYS: Record<string, BuildableKind> = {
  Digit1: "house",
  Digit2: "barn",
  Digit3: "smithy",
  Digit4: "barracks",
  Digit5: "mine",
  Digit6: "hayField",
};

export interface Controls {
  update: (dtSec: number) => void; // advance camera from pan/edge-scroll
  getView: () => View;
  setViewport: (w: number, h: number) => void;
}

export function createControls(opts: {
  canvas: HTMLCanvasElement;
  getState: () => GameState;
  enqueue: (cmd: Command) => void;
  onTogglePause: () => void;
}): Controls {
  const { canvas, getState, enqueue, onTogglePause } = opts;

  let viewW = canvas.clientWidth || 1;
  let viewH = canvas.clientHeight || 1;
  let camera: Camera = centerOnTile(HAMLET_CENTER, viewW, viewH);
  let selection: number[] = [];
  let selectedBuilding: number | null = null;
  let placementKind: BuildableKind | null = null;

  const held = new Set<string>();
  const mouse = { x: 0, y: 0, inside: false };
  const drag: DragState = {
    active: false,
    startX: 0,
    startY: 0,
    curX: 0,
    curY: 0,
    moved: false,
  };

  function pos(e: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function unitAtScreen(sx: number, sy: number): number | null {
    const wx = sx + camera.x;
    const wy = sy + camera.y;
    let best: number | null = null;
    let bestD = (TILE_SIZE * 0.5) ** 2;
    for (const u of Object.values(getState().units)) {
      if (u.insideBuildingId !== null) continue;
      const cx = (u.x + 0.5) * TILE_SIZE;
      const cy = (u.y + 0.5) * TILE_SIZE;
      const d = (cx - wx) ** 2 + (cy - wy) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = u.id;
      }
    }
    return best;
  }

  // Right-click target resolution (req §6.5): the tile under the cursor decides
  // the order — resource tile → gather, ploughed/grown field → plant/harvest,
  // otherwise a plain move. Ploughing is not a default right-click (every grass
  // tile is ploughable); it is bound to the F key below.
  function rightClickCommand(tx: number, ty: number): Command | null {
    if (selection.length === 0) return null;
    const s = getState();
    if (!inBounds(s.map, tx, ty)) return null;
    const ids = [...selection];
    const t = tileAt(s.map, tx, ty);
    const b = buildingAt(s.buildings, tx, ty);
    // Right-clicking a built mine that the unit can mine: route as `gather`
    // (the sim resolves it). For any other own-building, fall through to move.
    if (b && b.kind === "mine") {
      return { type: "gather", unitIds: ids, tx, ty };
    }
    if (t === "forest" || t === "water") {
      return { type: "gather", unitIds: ids, tx, ty };
    }
    const f = fieldAt(s.fields, tx, ty);
    if (f) {
      if (f.stage === "ploughed") return { type: "field", unitIds: ids, action: "plant", tx, ty };
      if (f.stage === "grown") return { type: "field", unitIds: ids, action: "harvest", tx, ty };
    }
    return { type: "moveUnits", unitIds: ids, tx, ty };
  }

  function boxSelect(): void {
    const x0 = Math.min(drag.startX, drag.curX) + camera.x;
    const y0 = Math.min(drag.startY, drag.curY) + camera.y;
    const x1 = Math.max(drag.startX, drag.curX) + camera.x;
    const y1 = Math.max(drag.startY, drag.curY) + camera.y;
    const ids: number[] = [];
    for (const u of Object.values(getState().units)) {
      if (u.insideBuildingId !== null) continue;
      const cx = (u.x + 0.5) * TILE_SIZE;
      const cy = (u.y + 0.5) * TILE_SIZE;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ids.push(u.id);
    }
    selection = ids;
    if (ids.length > 0) selectedBuilding = null;
  }

  function leftClickResolved(tx: number, ty: number, screenX: number, screenY: number): void {
    // Placement mode wins: a left-click in placement mode places the building.
    if (placementKind) {
      const s = getState();
      if (placementValid(s.map, s.buildings, s.fields, placementKind, tx, ty)) {
        enqueue({ type: "build", unitIds: [...selection], kind: placementKind, tx, ty });
      }
      placementKind = null; // one-shot; press the key again to place more
      return;
    }
    // Unit click first — most precise.
    const id = unitAtScreen(screenX, screenY);
    if (id !== null) {
      selection = [id];
      selectedBuilding = null;
      return;
    }
    // Building click: pick the building under the tile (if any).
    const b = buildingAt(getState().buildings, tx, ty);
    if (b) {
      selectedBuilding = b.id;
      selection = [];
      return;
    }
    // Clicked empty terrain: clear selection.
    selection = [];
    selectedBuilding = null;
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mouseenter", () => (mouse.inside = true));
  canvas.addEventListener("mouseleave", () => (mouse.inside = false));

  canvas.addEventListener("mousemove", (e) => {
    const p = pos(e);
    mouse.x = p.x;
    mouse.y = p.y;
    mouse.inside = true;
    if (drag.active) {
      drag.curX = p.x;
      drag.curY = p.y;
      if (
        Math.abs(p.x - drag.startX) > DRAG_SELECT_THRESHOLD_PX ||
        Math.abs(p.y - drag.startY) > DRAG_SELECT_THRESHOLD_PX
      ) {
        drag.moved = true;
      }
    }
  });

  canvas.addEventListener("mousedown", (e) => {
    const p = pos(e);
    if (e.button === 0) {
      drag.active = true;
      drag.startX = p.x;
      drag.startY = p.y;
      drag.curX = p.x;
      drag.curY = p.y;
      drag.moved = false;
    } else if (e.button === 2) {
      e.preventDefault();
      const tile = screenToTile(camera, p.x, p.y);
      // Right-click in placement mode cancels placement.
      if (placementKind) {
        placementKind = null;
        return;
      }
      const cmd = rightClickCommand(tile.x, tile.y);
      if (cmd) enqueue(cmd);
    }
  });

  // Listen on window so a drag that ends outside the canvas still resolves.
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || !drag.active) return;
    if (drag.moved) {
      boxSelect();
    } else {
      const tile = screenToTile(camera, drag.startX, drag.startY);
      leftClickResolved(tile.x, tile.y, drag.startX, drag.startY);
    }
    drag.active = false;
    drag.moved = false;
  });

  function selectedBuildingObj(): Building | null {
    if (selectedBuilding === null) return null;
    return getState().buildings[selectedBuilding] ?? null;
  }

  function hoveredTile(): { x: number; y: number } {
    return screenToTile(camera, mouse.x, mouse.y);
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      onTogglePause();
      return;
    }
    if (e.code === "Escape") {
      placementKind = null;
      selection = [];
      selectedBuilding = null;
      return;
    }
    if (PLACEMENT_KEYS[e.code]) {
      e.preventDefault();
      placementKind = PLACEMENT_KEYS[e.code];
      return;
    }
    // F: plough the grass tile under the cursor with the selected units (req §10).
    if (e.code === "KeyF") {
      if (selection.length > 0 && mouse.inside) {
        const tile = hoveredTile();
        const s = getState();
        const t = tileAt(s.map, tile.x, tile.y);
        if ((t === "grass" || t === "stump") && !fieldAt(s.fields, tile.x, tile.y) && !buildingAt(s.buildings, tile.x, tile.y)) {
          enqueue({ type: "field", unitIds: [...selection], action: "plough", tx: tile.x, ty: tile.y });
        }
      }
      return;
    }
    // X: demolish the selected building (req §7.1).
    if (e.code === "KeyX") {
      const b = selectedBuildingObj();
      if (b) {
        enqueue({ type: "demolish", buildingId: b.id });
        selectedBuilding = null;
      }
      return;
    }
    // R: repair the selected building with the selected workers (req §7.1).
    if (e.code === "KeyR") {
      const b = selectedBuildingObj();
      if (b && selection.length > 0) {
        enqueue({ type: "repair", buildingId: b.id, unitIds: [...selection] });
      }
      return;
    }
    // K / L: craft sword / shield in the selected smithy with selected worker.
    if (e.code === "KeyK" || e.code === "KeyL") {
      const b = selectedBuildingObj();
      if (b && b.kind === "smithy" && selection.length > 0) {
        enqueue({
          type: "craft",
          buildingId: b.id,
          item: e.code === "KeyK" ? "sword" : "shield",
          unitIds: [...selection],
        });
      }
      return;
    }
    // T: train selected unit in the selected barracks (worker→soldier or
    // soldier→captain, inferred from the selected unit's kind).
    if (e.code === "KeyT") {
      const b = selectedBuildingObj();
      if (b && b.kind === "barracks" && selection.length > 0) {
        const s = getState();
        const u = s.units[selection[0]];
        if (u) {
          const toKind =
            u.kind === "worker" ? "soldier"
            : u.kind === "soldier" ? "captain"
            : null;
          if (toKind) {
            enqueue({ type: "train", buildingId: b.id, toKind, unitIds: [u.id] });
          }
        }
      }
      return;
    }
    // C: cancel current order on selected units (used to pull operators out).
    if (e.code === "KeyC") {
      if (selection.length > 0) {
        enqueue({ type: "cancel", unitIds: [...selection] });
      }
      return;
    }
    if (PAN_KEYS[e.code]) {
      e.preventDefault();
      held.add(e.code);
    }
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));

  function update(dtSec: number): void {
    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const d = PAN_KEYS[code];
      if (d) {
        dx += d[0];
        dy += d[1];
      }
    }
    if (mouse.inside) {
      if (mouse.x < EDGE_SCROLL_MARGIN_PX) dx -= 1;
      else if (mouse.x > viewW - EDGE_SCROLL_MARGIN_PX) dx += 1;
      if (mouse.y < EDGE_SCROLL_MARGIN_PX) dy -= 1;
      else if (mouse.y > viewH - EDGE_SCROLL_MARGIN_PX) dy += 1;
    }
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      camera = clampCamera(
        {
          x: camera.x + (dx / len) * CAMERA_PAN_PX_PER_SEC * dtSec,
          y: camera.y + (dy / len) * CAMERA_PAN_PX_PER_SEC * dtSec,
        },
        viewW,
        viewH,
      );
    }
  }

  function placementGhost(): PlacementGhost | null {
    if (!placementKind || !mouse.inside) return null;
    const tile = hoveredTile();
    const s = getState();
    const valid = placementValid(s.map, s.buildings, s.fields, placementKind, tile.x, tile.y);
    return { tx: tile.x, ty: tile.y, valid };
  }

  function getView(): View {
    let dragBox: DragBox | null = null;
    if (drag.active && drag.moved) {
      dragBox = {
        x: Math.min(drag.startX, drag.curX),
        y: Math.min(drag.startY, drag.curY),
        w: Math.abs(drag.curX - drag.startX),
        h: Math.abs(drag.curY - drag.startY),
      };
    }
    return {
      camera,
      selection: [...selection],
      selectedBuildings: selectedBuilding !== null ? [selectedBuilding] : [],
      dragBox,
      placement: placementGhost(),
    };
  }

  function setViewport(w: number, h: number): void {
    viewW = w || 1;
    viewH = h || 1;
    camera = clampCamera(camera, viewW, viewH);
  }

  return { update, getView, setViewport };
}
