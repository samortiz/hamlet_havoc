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
  HEX_SIZE,
  MAP_WIDTH,
  type BuildCost,
} from "../config/index.js";
import {
  buildableCost,
  canAfford,
  placementValid,
  unitCount,
  workerHousingCap,
} from "../game/actions.js";
import { buildingAt, isBuilt, type Building } from "../game/buildings.js";
import type { Enemy } from "../game/combat.js";
import type { BuildableKind, Command } from "../game/commands.js";
import { fieldAt } from "../game/fields.js";
import { fieldActionInSeason, seasonAt } from "../game/season.js";
import type { ResourcePool, ResourceType } from "../game/resources.js";
import { hexToPixel } from "../game/hex.js";
import { forestRemaining, HAMLET_CENTER, inBounds, isTownTile, tileAt, type TileCoord } from "../game/map.js";
import type { GameState } from "../game/state.js";
import { hasHorse, type FieldAction, type UnitKind } from "../game/units.js";
import {
  centerOnTile,
  clampCamera,
  screenToHex,
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

// Digit → buildable kind (req §7.1). Digit 1 = House, ... 6 = Stables.
const PLACEMENT_KEYS: Record<string, BuildableKind> = {
  Digit1: "house",
  Digit2: "barn",
  Digit3: "smithy",
  Digit4: "barracks",
  Digit5: "mine",
  Digit6: "stables",
};

export interface Controls {
  update: (dtSec: number) => void; // advance camera from WASD pan
  getView: () => View;
  setViewport: (w: number, h: number) => void;
  centerOn: (tile: TileCoord) => void; // jump the camera to a tile (enemy notices)
}

export function createControls(opts: {
  canvas: HTMLCanvasElement;
  getState: () => GameState;
  enqueue: (cmd: Command) => void;
  onTogglePause: () => void;
  // Step the game speed down (−1) or up (+1) — the [ and ] keys (req §15.4).
  onCycleSpeed: (dir: -1 | 1) => void;
  actionPanel: HTMLElement;
}): Controls {
  const { canvas, getState, enqueue, onTogglePause, onCycleSpeed, actionPanel } = opts;

  let viewW = canvas.clientWidth || 1;
  let viewH = canvas.clientHeight || 1;
  let camera: Camera = centerOnTile(HAMLET_CENTER, viewW, viewH);
  let selection: number[] = [];
  let selectedBuilding: number | null = null;
  // Tracks the selected Main Hall's worker-production flag so the panel can
  // rebuild when it flips (start / completion) without polling every frame.
  let lastSpawning = false;
  let placementKind: BuildableKind | null = null;
  // Pending field action (plough/plant/harvest). Works like building placement:
  // pick the action, then left-click the target cell. null = not in field mode.
  let pendingField: FieldAction | null = null;
  let hoveredUnitId: number | null = null;
  let hoveredBuildingId: number | null = null;
  let hoveredForestWood: number | null = null;
  // Build buttons, kept so their affordability (disabled state + cost tooltip)
  // can be refreshed every frame as resources change — not just on rebuild.
  let buildButtons: Array<[BuildableKind, HTMLButtonElement]> = [];

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

  function apSection(label: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "ap-section";
    const lbl = document.createElement("span");
    lbl.className = "ap-label";
    lbl.textContent = label + ":";
    div.append(lbl);
    return div;
  }

  function apButton(label: string, onClick: () => void, active = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (active) btn.classList.add("active");
    btn.addEventListener("click", onClick);
    return btn;
  }

  // Is `action` legal on the tile at (tx, ty)? Plough needs bare grass/stump
  // (no field, no building); plant needs a ploughed field; harvest needs a
  // grown one. Used both to gate the click and to colour the ghost preview.
  function fieldActionValid(s: GameState, action: FieldAction, tx: number, ty: number): boolean {
    if (!inBounds(s.map, tx, ty)) return false;
    // Season lock (req §15.3): plant is spring-only, harvest is fall-only. This
    // also reds out the ghost preview when the action is out of season.
    if (!fieldActionInSeason(action, seasonAt(s.tickCount))) return false;
    const f = fieldAt(s.fields, tx, ty);
    if (action === "plough") {
      const t = tileAt(s.map, tx, ty);
      if (isTownTile(s.town, tx, ty)) return false; // town flower is reserved (req §18)
      return (t === "grass" || t === "stump") && !f && !buildingAt(s.buildings, tx, ty);
    }
    if (action === "plant") return !!f && f.stage === "ploughed";
    return !!f && f.stage === "grown"; // harvest
  }

  // Tooltip text for a build button: the full cost, plus a "Missing:" line
  // listing the shortfall when the player can't currently afford it.
  function costTooltip(cost: BuildCost, res: ResourcePool): string {
    const parts: string[] = [];
    const missing: string[] = [];
    for (const k of Object.keys(cost) as ResourceType[]) {
      const need = cost[k] ?? 0;
      if (need <= 0) continue;
      const name = k.charAt(0).toUpperCase() + k.slice(1);
      parts.push(`${need} ${name}`);
      const have = res[k] ?? 0;
      if (have < need) missing.push(`${need - have} ${name}`);
    }
    let s = parts.length ? `Cost: ${parts.join(", ")}` : "No cost";
    if (missing.length) s += `\nMissing: ${missing.join(", ")}`;
    return s;
  }

  // Refresh each build button's disabled look + cost tooltip from current
  // resources. Cheap (6 buttons), so the frame loop calls it every tick.
  function refreshBuildButtons(): void {
    const res = getState().resources;
    for (const [kind, btn] of buildButtons) {
      const cost = buildableCost(kind);
      const affordable = canAfford(res, cost);
      btn.classList.toggle("disabled", !affordable);
      btn.setAttribute("aria-disabled", String(!affordable));
      btn.title = costTooltip(cost, res);
    }
  }

  function rebuildActionPanel(): void {
    actionPanel.innerHTML = "";

    // Build section — always visible; buttons mirror the digit key shortcuts.
    const buildSection = apSection("Build");
    const buildKinds: Array<[BuildableKind, string]> = [
      ["house", "1 House"],
      ["barn", "2 Barn"],
      ["smithy", "3 Smithy"],
      ["barracks", "4 Barracks"],
      ["mine", "5 Mine"],
      ["stables", "6 Stables"],
    ];
    buildButtons = [];
    for (const [kind, label] of buildKinds) {
      const btn = apButton(label, () => {
        // Guard: ignore clicks on unaffordable builds (kept clickable only so
        // the cost tooltip stays visible on hover).
        if (!canAfford(getState().resources, buildableCost(kind))) return;
        placementKind = kind;
        rebuildActionPanel();
      }, placementKind === kind);
      buildButtons.push([kind, btn]);
      buildSection.append(btn);
    }
    actionPanel.append(buildSection);

    // Unit actions — visible when at least one unit is selected.
    if (selection.length > 0) {
      const unitSection = apSection("Unit");
      const fieldButton = (action: FieldAction, label: string): HTMLButtonElement =>
        apButton(
          label,
          () => { pendingField = pendingField === action ? null : action; rebuildActionPanel(); },
          pendingField === action,
        );
      unitSection.append(
        apButton("Cancel", () => { enqueue({ type: "cancel", unitIds: [...selection] }); }),
        fieldButton("plough", "Plough"),
        fieldButton("plant", "Plant"),
        fieldButton("harvest", "Harvest"),
      );

      // Equipment toggles (req §6.4) — keyed off the first selected unit's state,
      // applied to the whole selection (pulls from / returns to the pool).
      const lead = getState().units[selection[0]];
      if (lead) {
        const equip = getState().equipment;
        const equipButton = (item: "sword" | "shield"): HTMLButtonElement => {
          const have = lead.equipped[item];
          const label = `${have ? "Unequip" : "Equip"} ${item.charAt(0).toUpperCase() + item.slice(1)}`;
          const btn = apButton(label, () => {
            enqueue({ type: "equip", unitIds: [...selection], item, equip: !have });
          });
          // Disable "Equip" when the pool is empty and the lead isn't holding one.
          if (!have && equip[item] <= 0) {
            btn.classList.add("disabled");
            btn.setAttribute("aria-disabled", "true");
          }
          return btn;
        };
        unitSection.append(equipButton("sword"), equipButton("shield"));

        // Mount / Dismount (req §9). Dismount when the lead unit has a horse;
        // otherwise offer Mount when a riderless horse exists to claim.
        if (hasHorse(lead)) {
          unitSection.append(
            apButton("Dismount", () => { enqueue({ type: "dismount", unitIds: [...selection] }); }),
          );
        } else if (Object.keys(getState().horses).length > 0) {
          unitSection.append(
            apButton("Mount", () => { enqueue({ type: "mount", unitIds: [...selection] }); }),
          );
        }
      }

      actionPanel.append(unitSection);
    }

    // Building actions — visible when a building is selected.
    if (selectedBuilding !== null) {
      const b = getState().buildings[selectedBuilding];
      if (b) {
        const bSection = apSection("Building");

        if (b.kind !== "mainHall") {
          bSection.append(
            apButton("Demolish", () => {
              enqueue({ type: "demolish", buildingId: b.id });
              selectedBuilding = null;
              rebuildActionPanel();
            }),
          );
        }

        // Main Hall: raise a new worker for free. Disabled while one is
        // already in production or when worker housing is full (§7.4).
        if (b.kind === "mainHall" && isBuilt(b)) {
          const st = getState();
          const housingFull =
            unitCount(st.units, "worker") >= workerHousingCap(st.buildings);
          const label = b.spawning ? "Creating Worker…" : "Create Worker";
          const btn = apButton(label, () => {
            enqueue({ type: "spawnWorker", buildingId: b.id });
          });
          if (b.spawning || housingFull) {
            btn.classList.add("disabled");
            btn.setAttribute("aria-disabled", "true");
            btn.title = b.spawning
              ? "A worker is already being raised"
              : "No free house slot — build a House first";
          }
          bSection.append(btn);
        }

        // Under construction: workers can resume building. Built but damaged:
        // workers can repair. (Both need at least one worker selected.)
        if (selection.length > 0 && !isBuilt(b)) {
          bSection.append(
            apButton("Resume", () => {
              enqueue({ type: "resumeBuild", buildingId: b.id, unitIds: [...selection] });
            }),
          );
        } else if (selection.length > 0 && b.hp < b.maxHp) {
          bSection.append(
            apButton("Repair", () => {
              enqueue({ type: "repair", buildingId: b.id, unitIds: [...selection] });
            }),
          );
        }

        if (b.kind === "smithy" && isBuilt(b) && selection.length > 0) {
          bSection.append(
            apButton("Craft Sword", () => {
              enqueue({ type: "craft", buildingId: b.id, item: "sword", unitIds: [...selection] });
            }),
            apButton("Craft Shield", () => {
              enqueue({ type: "craft", buildingId: b.id, item: "shield", unitIds: [...selection] });
            }),
          );
        }

        if (b.kind === "barracks" && isBuilt(b) && selection.length > 0) {
          const u = getState().units[selection[0]];
          if (u) {
            const toKind: UnitKind | null =
              u.kind === "worker" ? "soldier"
              : u.kind === "soldier" ? "captain"
              : null;
            if (toKind) {
              const trainLabel = toKind === "soldier" ? "Train → Soldier" : "Train → Captain";
              bSection.append(
                apButton(trainLabel, () => {
                  enqueue({ type: "train", buildingId: b.id, toKind: toKind!, unitIds: [u.id] });
                }),
              );
            }
          }
        }

        actionPanel.append(bSection);
      }
    }

    refreshBuildButtons();
  }

  // Seed the panel on startup.
  rebuildActionPanel();

  function pos(e: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function unitAtScreen(sx: number, sy: number): number | null {
    const wx = sx + camera.x;
    const wy = sy + camera.y;
    let best: number | null = null;
    let bestD = (HEX_SIZE * 0.6) ** 2;
    for (const u of Object.values(getState().units)) {
      if (u.insideBuildingId !== null) continue;
      const { px, py } = hexToPixel(u.x, u.y);
      const d = (px - wx) ** 2 + (py - wy) ** 2;
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
    // Enemy under the cursor → attack it (req §6.5).
    const enemy = enemyAtTile(s, tx, ty);
    if (enemy) return { type: "attack", unitIds: ids, targetEnemyId: enemy.id };
    // The town tile → just walk there. On arrival (idle at town) the marketplace
    // interface opens for trading (req §18). The "Sell at Town" / "Buy Horse"
    // action-panel buttons remain as quick auto-trade shortcuts.
    if (tx === s.town.x && ty === s.town.y) {
      return { type: "moveUnits", unitIds: ids, tx, ty };
    }
    const t = tileAt(s.map, tx, ty);
    const b = buildingAt(s.buildings, tx, ty);
    // Right-clicking an under-construction building sends the workers to resume
    // building it (req §7.1: builders can be interrupted and re-tasked).
    if (b && !isBuilt(b)) {
      return { type: "resumeBuild", unitIds: ids, buildingId: b.id };
    }
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

  function enemyAtTile(s: GameState, tx: number, ty: number): Enemy | null {
    for (const e of Object.values(s.enemies)) {
      if (Math.round(e.x) === tx && Math.round(e.y) === ty) return e;
    }
    return null;
  }

  function boxSelect(): void {
    const x0 = Math.min(drag.startX, drag.curX) + camera.x;
    const y0 = Math.min(drag.startY, drag.curY) + camera.y;
    const x1 = Math.max(drag.startX, drag.curX) + camera.x;
    const y1 = Math.max(drag.startY, drag.curY) + camera.y;
    const ids: number[] = [];
    for (const u of Object.values(getState().units)) {
      if (u.insideBuildingId !== null) continue;
      const { px, py } = hexToPixel(u.x, u.y);
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) ids.push(u.id);
    }
    selection = ids;
    if (ids.length > 0) selectedBuilding = null;
    rebuildActionPanel();
  }

  function leftClickResolved(tx: number, ty: number, screenX: number, screenY: number): void {
    // Pending field action (plough/plant/harvest): left-click the target cell
    // issues the command, mirroring building placement. One-shot — re-pick the
    // action to do another tile.
    if (pendingField && selection.length > 0) {
      const s = getState();
      if (fieldActionValid(s, pendingField, tx, ty)) {
        enqueue({ type: "field", unitIds: [...selection], action: pendingField, tx, ty });
      }
      pendingField = null;
      rebuildActionPanel();
      return;
    }
    // Placement mode wins: a left-click in placement mode places the building.
    if (placementKind) {
      const s = getState();
      if (placementValid(s.map, s.buildings, s.fields, placementKind, tx, ty, s.town)) {
        enqueue({ type: "build", unitIds: [...selection], kind: placementKind, tx, ty });
      }
      placementKind = null; // one-shot; press the key again to place more
      rebuildActionPanel();
      return;
    }
    // Unit click first — most precise.
    const id = unitAtScreen(screenX, screenY);
    if (id !== null) {
      selection = [id];
      selectedBuilding = null;
      rebuildActionPanel();
      return;
    }
    // Building click: pick the building under the tile (if any). Keep any
    // selected units so the Building-section actions that need workers (Resume,
    // Repair, Craft, Train) are reachable — select the workers, then the building.
    const b = buildingAt(getState().buildings, tx, ty);
    if (b) {
      selectedBuilding = b.id;
      rebuildActionPanel();
      return;
    }
    // Clicked empty terrain: clear selection.
    selection = [];
    selectedBuilding = null;
    rebuildActionPanel();
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mouseenter", () => (mouse.inside = true));
  canvas.addEventListener("mouseleave", () => {
    mouse.inside = false;
    hoveredUnitId = null;
    hoveredBuildingId = null;
    hoveredForestWood = null;
  });

  canvas.addEventListener("mousemove", (e) => {
    const p = pos(e);
    mouse.x = p.x;
    mouse.y = p.y;
    mouse.inside = true;
    hoveredUnitId = unitAtScreen(p.x, p.y);
    // A hovered unit takes precedence; otherwise surface the building — or, on a
    // bare forest tile, its remaining wood (req §12) — under the cursor.
    hoveredBuildingId = null;
    hoveredForestWood = null;
    if (hoveredUnitId === null) {
      const tile = screenToHex(camera, p.x, p.y);
      const s = getState();
      const b = buildingAt(s.buildings, tile.x, tile.y);
      if (b) {
        hoveredBuildingId = b.id;
      } else if (inBounds(s.map, tile.x, tile.y) && tileAt(s.map, tile.x, tile.y) === "forest") {
        hoveredForestWood = forestRemaining(s.map, tile.y * MAP_WIDTH + tile.x);
      }
    }
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
      const tile = screenToHex(camera, p.x, p.y);
      // Right-click cancels an active placement / field-action mode.
      if (placementKind || pendingField) {
        placementKind = null;
        pendingField = null;
        rebuildActionPanel();
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
      const tile = screenToHex(camera, drag.startX, drag.startY);
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
    return screenToHex(camera, mouse.x, mouse.y);
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      onTogglePause();
      return;
    }
    // [ / ] : slow down / speed up game time (req §15.4, §20).
    if (e.code === "BracketLeft") {
      onCycleSpeed(-1);
      return;
    }
    if (e.code === "BracketRight") {
      onCycleSpeed(1);
      return;
    }
    if (e.code === "Escape") {
      placementKind = null;
      pendingField = null;
      selection = [];
      selectedBuilding = null;
      rebuildActionPanel();
      return;
    }
    if (PLACEMENT_KEYS[e.code]) {
      e.preventDefault();
      placementKind = PLACEMENT_KEYS[e.code];
      rebuildActionPanel();
      return;
    }
    // F: enter plough mode (then left-click the target tile). Mirrors the
    // building-placement flow: choose the action first, then the cell.
    if (e.code === "KeyF") {
      if (selection.length > 0) {
        pendingField = pendingField === "plough" ? null : "plough";
        rebuildActionPanel();
      }
      return;
    }
    // X: demolish the selected building (req §7.1).
    if (e.code === "KeyX") {
      const b = selectedBuildingObj();
      if (b) {
        enqueue({ type: "demolish", buildingId: b.id });
        selectedBuilding = null;
        rebuildActionPanel();
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
    // H: mount / dismount the selected units (req §9). Dismount if the lead unit
    // has a horse, otherwise send the selection to the nearest riderless horse.
    if (e.code === "KeyH") {
      if (selection.length > 0) {
        const u = getState().units[selection[0]];
        if (u && hasHorse(u)) enqueue({ type: "dismount", unitIds: [...selection] });
        else enqueue({ type: "mount", unitIds: [...selection] });
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
    // Keep build-button affordability + cost tooltips in sync with the live
    // resource pool (the panel itself only rebuilds on selection change).
    refreshBuildButtons();

    // Rebuild the panel when a selected Main Hall starts/finishes raising a
    // worker, so the Create Worker button reflects the live state.
    if (selectedBuilding !== null) {
      const sel = getState().buildings[selectedBuilding];
      const spawning = sel?.kind === "mainHall" && sel.spawning;
      if (spawning !== lastSpawning) {
        lastSpawning = spawning;
        rebuildActionPanel();
      }
    }

    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const d = PAN_KEYS[code];
      if (d) {
        dx += d[0];
        dy += d[1];
      }
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
    if (!mouse.inside) return null;
    const tile = hoveredTile();
    const s = getState();
    if (placementKind) {
      const valid = placementValid(s.map, s.buildings, s.fields, placementKind, tile.x, tile.y, s.town);
      return { tx: tile.x, ty: tile.y, valid };
    }
    if (pendingField && selection.length > 0) {
      const valid = fieldActionValid(s, pendingField, tile.x, tile.y);
      return { tx: tile.x, ty: tile.y, valid };
    }
    return null;
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
      hoveredUnitId,
      hoveredBuildingId,
      hoveredForestWood,
      mouseScreenX: mouse.x,
      mouseScreenY: mouse.y,
    };
  }

  function setViewport(w: number, h: number): void {
    viewW = w || 1;
    viewH = h || 1;
    camera = clampCamera(camera, viewW, viewH);
  }

  // Recenter the camera on a tile (clicking an enemy-sighting notice jumps
  // the player to the combat).
  function centerOn(tile: TileCoord): void {
    camera = centerOnTile(tile, viewW, viewH);
  }

  return { update, getView, setViewport, centerOn };
}
