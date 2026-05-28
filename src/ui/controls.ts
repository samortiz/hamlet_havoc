// Input + selection layer (req §2.6, §4.4, §6.5, §20). Translates raw browser
// events into camera movement, unit selection (click / drag-box), and move
// commands (right-click). Selection and camera are view state held here, not in
// the simulation; commands are the only thing handed to the sim.

import {
  CAMERA_PAN_PX_PER_SEC,
  DRAG_SELECT_THRESHOLD_PX,
  EDGE_SCROLL_MARGIN_PX,
  TILE_SIZE,
} from "../config/index.js";
import type { Command } from "../game/commands.js";
import { HAMLET_CENTER } from "../game/map.js";
import type { GameState } from "../game/state.js";
import {
  centerOnTile,
  clampCamera,
  screenToTile,
  type Camera,
  type DragBox,
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

  function boxSelect(): void {
    const x0 = Math.min(drag.startX, drag.curX) + camera.x;
    const y0 = Math.min(drag.startY, drag.curY) + camera.y;
    const x1 = Math.max(drag.startX, drag.curX) + camera.x;
    const y1 = Math.max(drag.startY, drag.curY) + camera.y;
    const ids: number[] = [];
    for (const u of Object.values(getState().units)) {
      const cx = (u.x + 0.5) * TILE_SIZE;
      const cy = (u.y + 0.5) * TILE_SIZE;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ids.push(u.id);
    }
    selection = ids;
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
      if (selection.length > 0) {
        const tile = screenToTile(camera, p.x, p.y);
        enqueue({ type: "moveUnits", unitIds: [...selection], tx: tile.x, ty: tile.y });
      }
    }
  });

  // Listen on window so a drag that ends outside the canvas still resolves.
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || !drag.active) return;
    if (drag.moved) boxSelect();
    else {
      const id = unitAtScreen(drag.startX, drag.startY);
      selection = id === null ? [] : [id];
    }
    drag.active = false;
    drag.moved = false;
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      onTogglePause();
      return;
    }
    if (e.code === "Escape") {
      selection = [];
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
    return { camera, selection: [...selection], dragBox };
  }

  function setViewport(w: number, h: number): void {
    viewW = w || 1;
    viewH = h || 1;
    camera = clampCamera(camera, viewW, viewH);
  }

  return { update, getView, setViewport };
}
