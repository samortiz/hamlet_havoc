// Hall / storage loading interface. A modal panel — styled like the town
// marketplace — that opens when the player selects a built storage building
// (Main Hall, Barn, …) while a unit is standing on or next to it. It lets the
// player:
//   - unload a returning worker's goods into the hamlet's shared pool, and
//   - load a worker up from the pool (e.g. to take goods to town).
//
// Read-only with respect to simulation state: every transfer is emitted as a
// `hallStore` Command and applied by update(). Unlike the town interface this
// moves goods to/from the hamlet `resources` pool, so it respects the cap.

import { isUnitAtBuilding } from "../game/actions.js";
import { isStorage, storageCapacity, type Building } from "../game/buildings.js";
import type { Command } from "../game/commands.js";
import {
  carriedTotal,
  poolTotal,
  RESOURCE_TYPES,
  RESOURCE_VALUE,
  type ResourceType,
} from "../game/resources.js";
import type { GameState } from "../game/state.js";
import { canCarryResource, carryCap, type Unit } from "../game/units.js";
import type { View } from "./camera.js";

export interface HallPanel {
  update: (state: GameState, view: View) => void;
}

const RESOURCE_LABEL: Record<ResourceType, string> = {
  wheat: "Wheat",
  wood: "Wood",
  stone: "Stone",
  meat: "Meat",
  iron: "Iron",
  gold: "Gold",
  diamond: "Diamond",
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function createHallPanel(opts: {
  container: HTMLElement;
  getState: () => GameState;
  enqueue: (cmd: Command) => void;
}): HallPanel {
  const { container, getState, enqueue } = opts;

  let activeBuildingId: number | null = null;
  let activeUnitId: number | null = null;
  // Building ids the player has closed the panel on; suppressed until the
  // selection changes off that building and back.
  const dismissed = new Set<number>();
  let lastBuildingId: number | null = null;
  let lastSig = "";

  // The selected built storage building, if any (opens on Main Hall / Barn).
  function activeBuilding(state: GameState, view: View): Building | null {
    for (const id of view.selectedBuildings) {
      const b = state.buildings[id];
      if (b && isStorage(b)) return b;
    }
    return null;
  }

  // The unit whose load/unload we show: any unit on or beside the building,
  // preferring one in the current selection, else the lowest id. Captains can
  // load/unload too, but only their gold/diamond (enforced per-row below and by
  // the sim's canCarryResource gate — req §6.1, §7.6).
  function activeUnit(state: GameState, building: Building, view: View): Unit | null {
    const near: Unit[] = [];
    for (const u of Object.values(state.units)) {
      if (u.insideBuildingId !== null) continue;
      if (isUnitAtBuilding(u, building)) near.push(u);
    }
    if (near.length === 0) return null;
    const selected = near.find((u) => view.selection.includes(u.id));
    if (selected) return selected;
    near.sort((a, b) => a.id - b.id);
    return near[0];
  }

  function btn(
    label: string,
    onClick: (e: MouseEvent) => void,
    opt: { disabled?: boolean; title?: string } = {},
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (opt.title) b.title = opt.title;
    if (opt.disabled) {
      b.classList.add("disabled");
      b.setAttribute("aria-disabled", "true");
    } else {
      b.addEventListener("click", onClick);
    }
    return b;
  }

  function column(title: string): { col: HTMLElement; body: HTMLElement } {
    const col = document.createElement("div");
    col.className = "town-col";
    const h = document.createElement("div");
    h.className = "town-col-title";
    h.textContent = title;
    const body = document.createElement("div");
    body.className = "town-col-body";
    col.append(h, body);
    return { col, body };
  }

  function row(label: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "town-row";
    const name = document.createElement("span");
    name.className = "town-row-name";
    name.textContent = label;
    r.append(name);
    return r;
  }

  function rebuild(state: GameState, building: Building, unit: Unit): void {
    container.innerHTML = "";
    const res = state.resources;
    const capacity = storageCapacity(state.buildings);
    const poolUsed = poolTotal(res);
    const poolSpace = Math.max(0, capacity - poolUsed);
    const load = carriedTotal(unit.carrying);
    const room = Math.max(0, carryCap(unit) - load);

    // Header --------------------------------------------------------------
    const header = document.createElement("div");
    header.className = "town-header";
    const title = document.createElement("span");
    title.className = "town-title";
    title.textContent = `${cap(building.kind === "mainHall" ? "Main Hall" : building.kind)} — ${cap(unit.kind)} #${unit.id}`;
    const headerBtns = document.createElement("span");
    headerBtns.className = "town-header-btns";
    headerBtns.append(
      btn("Unload All", () => unloadAll(), {
        disabled: load <= 0 || poolSpace <= 0,
        title: poolSpace <= 0 ? "Hamlet storage is full" : "Store everything carried",
      }),
      btn("Close", () => { dismissed.add(building.id); }, { title: "Hide this panel" }),
    );
    header.append(title, headerBtns);

    const grid = document.createElement("div");
    grid.className = "town-grid";

    // Hamlet Storage ------------------------------------------------------
    const storeCol = column(`Hamlet Storage ${poolUsed}/${capacity}`);
    let anyStore = false;
    for (const t of RESOURCE_TYPES) {
      const have = res[t];
      if (have <= 0) continue;
      anyStore = true;
      const r = row(`${have} ${RESOURCE_LABEL[t]}`);
      const val = document.createElement("span");
      val.className = "town-val";
      val.textContent = `v${RESOURCE_VALUE[t]}`;
      const canCarry = canCarryResource(unit, t);
      r.append(
        val,
        btn("Load", (e) => load1(t, e.shiftKey ? room : 1), {
          disabled: room <= 0 || !canCarry,
          title: !canCarry
            ? `A ${unit.kind} can't carry ${RESOURCE_LABEL[t].toLowerCase()}`
            : room <= 0
              ? "Carry full"
              : "Load onto the unit (shift: all that fits)",
        }),
      );
      storeCol.body.append(r);
    }
    if (!anyStore) {
      const empty = document.createElement("div");
      empty.className = "town-empty";
      empty.textContent = "Storage is empty.";
      storeCol.body.append(empty);
    }

    // Carrying ------------------------------------------------------------
    const invCol = column(`Carrying ${load}/${carryCap(unit)}`);
    let anyInv = false;
    for (const t of RESOURCE_TYPES) {
      const have = unit.carrying[t] ?? 0;
      if (have <= 0) continue;
      anyInv = true;
      const r = row(`${have} ${RESOURCE_LABEL[t]}`);
      r.append(
        btn("Store", (e) => store1(t, e.shiftKey ? have : 1), {
          disabled: poolSpace <= 0,
          title: poolSpace <= 0 ? "Hamlet storage is full" : "Unload into storage (shift: all)",
        }),
      );
      invCol.body.append(r);
    }
    if (!anyInv) {
      const empty = document.createElement("div");
      empty.className = "town-empty";
      empty.textContent = "Carrying nothing.";
      invCol.body.append(empty);
    }

    grid.append(storeCol.col, invCol.col);
    container.append(header, grid);
  }

  function load1(t: ResourceType, amount: number): void {
    if (activeUnitId === null || activeBuildingId === null) return;
    enqueue({ type: "hallStore", unitId: activeUnitId, buildingId: activeBuildingId, resource: t, amount, toStorage: false });
  }

  function store1(t: ResourceType, amount: number): void {
    if (activeUnitId === null || activeBuildingId === null) return;
    enqueue({ type: "hallStore", unitId: activeUnitId, buildingId: activeBuildingId, resource: t, amount, toStorage: true });
  }

  // Store every carried resource into the pool (one command per type; each is
  // cap-clamped by the sim, so a full pool just absorbs what fits).
  function unloadAll(): void {
    if (activeUnitId === null) return;
    const u = getState().units[activeUnitId];
    if (!u) return;
    for (const t of RESOURCE_TYPES) {
      const have = u.carrying[t] ?? 0;
      if (have > 0) store1(t, have);
    }
  }

  function signature(state: GameState, building: Building, unit: Unit): string {
    return JSON.stringify([
      building.id,
      unit.id,
      unit.carrying,
      unit.horseHp,
      state.resources,
      storageCapacity(state.buildings),
    ]);
  }

  function hide(): void {
    if (!container.hidden) {
      container.hidden = true;
      container.innerHTML = "";
    }
    activeBuildingId = null;
    activeUnitId = null;
    lastSig = "";
  }

  function update(state: GameState, view: View): void {
    const building = activeBuilding(state, view);
    // Clear dismissals once the selection moves off the building so it reopens.
    const selId = building?.id ?? null;
    if (selId !== lastBuildingId) {
      if (lastBuildingId !== null) dismissed.delete(lastBuildingId);
      lastBuildingId = selId;
      // the panel auto-opens only for a unit already present when the
      // building is selected. If none is there at selection time, suppress it
      // until the player reselects — so a worker spawned by (or returning to)
      // an already-selected Main Hall does not pop the dialog open.
      if (building && !activeUnit(state, building, view)) dismissed.add(building.id);
    }
    if (!building || dismissed.has(building.id)) {
      hide();
      return;
    }
    const unit = activeUnit(state, building, view);
    if (!unit) {
      hide();
      return;
    }
    if (building.id !== activeBuildingId || unit.id !== activeUnitId) {
      activeBuildingId = building.id;
      activeUnitId = unit.id;
      lastSig = "";
    }
    const sig = signature(state, building, unit);
    if (sig !== lastSig) {
      rebuild(state, building, unit);
      lastSig = sig;
    }
    container.hidden = false;
  }

  return { update };
}
