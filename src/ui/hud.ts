// HUD layer (req §2.2, §19). Reads GameState and reflects it into the HTML
// overlay (resource bar, pooled storage, season/timer, population caps,
// equipment counts, build menu). Read-only with respect to simulation state;
// the Save/Load/New buttons invoke caller-supplied callbacks rather than
// touching state directly.

import {
  barracksHousingCap,
  unitCount,
  workerHousingCap,
} from "../game/actions.js";
import { storageCapacity } from "../game/buildings.js";
import { poolTotal, RESOURCE_TYPES, type ResourceType } from "../game/resources.js";
import { deriveSeason, type GameState } from "../game/state.js";
import { maxHp, type Order } from "../game/units.js";
import type { View } from "./camera.js";

export interface HudCallbacks {
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
}

export interface Hud {
  update: (state: GameState, paused: boolean, view: View) => void;
  flash: (message: string) => void;
}

const RESOURCE_LABEL: Record<ResourceType, string> = {
  hay: "Hay",
  wheat: "Wheat",
  wood: "Wood",
  stone: "Stone",
  meat: "Meat",
  iron: "Iron",
  gold: "Gold",
  diamond: "Diamond",
};

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD element #${id} not found`);
  return node;
}

function describeOrder(order: Order): string {
  switch (order.type) {
    case "idle": return "Idle";
    case "move": return "Moving";
    case "gather": {
      const res = order.resource === "wood" ? "wood" : order.resource === "fish" ? "fish" : "ore";
      return (order.phase === "toStore" || order.phase === "storing")
        ? `Returning with ${res}` : `Gathering ${res}`;
    }
    case "field":
      if (order.action === "plough") return order.phase === "toTile" ? "Going to plough" : "Ploughing";
      if (order.action === "plant") return order.phase === "toTile" ? "Going to plant" : "Planting";
      return order.phase === "toTile" ? "Going to harvest" : "Harvesting";
    case "build":
      if (order.repair) return order.phase === "toSite" ? "Going to repair" : "Repairing";
      return order.phase === "toSite" ? "Going to build" : "Building";
    case "operate":
      switch (order.mode) {
        case "craftSword": return "Crafting sword";
        case "craftShield": return "Crafting shield";
        case "trainSoldier": return "Training → soldier";
        case "trainCaptain": return "Training → captain";
      }
  }
}

export function createHud(cb: HudCallbacks): Hud {
  const seasonEl = el("hud-season");
  const timerEl = el("hud-timer");
  const pausedEl = el("hud-paused");
  const tickEl = el("hud-tick");
  const resourcesEl = el("hud-resources");
  const storageEl = el("hud-storage");
  const toastEl = el("hud-toast");
  const popEl = el("hud-population");
  const equipEl = el("hud-equipment");
  const tooltipEl = el("unit-tooltip");
  const ttTitle = el("tt-title");
  const ttHp = el("tt-hp");
  const ttOrder = el("tt-order");
  const ttCarry = el("tt-carry");

  // Build one cell per resource, before the storage readout.
  const countEls = {} as Record<ResourceType, HTMLElement>;
  for (const t of RESOURCE_TYPES) {
    const cell = document.createElement("span");
    cell.className = "res";
    const label = document.createElement("span");
    label.className = "res-label";
    label.textContent = `${RESOURCE_LABEL[t]} `;
    const count = document.createElement("span");
    count.className = "res-count";
    count.textContent = "0";
    cell.append(label, count);
    resourcesEl.insertBefore(cell, storageEl);
    countEls[t] = count;
  }

  el("btn-new").addEventListener("click", cb.onNew);
  el("btn-save").addEventListener("click", cb.onSave);
  el("btn-load").addEventListener("click", cb.onLoad);

  let toastTimer = 0;
  function flash(message: string): void {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 1500);
  }

  function updateTooltip(state: GameState, view: View): void {
    if (view.hoveredUnitId === null) {
      tooltipEl.hidden = true;
      return;
    }
    const u = state.units[view.hoveredUnitId];
    if (!u) {
      tooltipEl.hidden = true;
      return;
    }

    ttTitle.textContent = u.kind.charAt(0).toUpperCase() + u.kind.slice(1);
    ttHp.textContent = `HP: ${u.hp} / ${maxHp(u.kind)}`;
    ttOrder.textContent = describeOrder(u.order);

    const carried: string[] = [];
    for (const t of RESOURCE_TYPES) {
      const v = u.carrying[t] ?? 0;
      if (v > 0) carried.push(`${v} ${t}`);
    }
    ttCarry.textContent = carried.length ? `Carrying: ${carried.join(", ")}` : "";
    ttCarry.hidden = carried.length === 0;

    // Position near cursor, flipping left/up if close to viewport edge.
    const mx = view.mouseScreenX;
    const my = view.mouseScreenY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = 160;
    const th = 90;
    const left = mx + 18 + tw > vw ? mx - tw - 8 : mx + 18;
    const top = my + th > vh ? my - th : my + 10;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
    tooltipEl.hidden = false;
  }

  function update(state: GameState, paused: boolean, view: View): void {
    const { season, year, secondsRemaining } = deriveSeason(state.tickCount);
    seasonEl.textContent = `${season}, Year ${year}`;
    timerEl.textContent = `${secondsRemaining}s`;
    tickEl.textContent = `tick ${state.tickCount}`;
    pausedEl.hidden = !paused;

    for (const t of RESOURCE_TYPES) countEls[t].textContent = String(state.resources[t]);
    storageEl.textContent = `Storage ${poolTotal(state.resources)}/${storageCapacity(state.buildings)}`;

    const workers = unitCount(state.units, "worker");
    const soldiers = unitCount(state.units, "soldier");
    const captains = unitCount(state.units, "captain");
    const workerCap = workerHousingCap(state.buildings);
    // Barracks house soldiers and captains in one shared pool (req §7.4).
    const barracksCap = barracksHousingCap(state.buildings);
    popEl.textContent = `Pop W:${workers}/${workerCap} · S+C:${soldiers + captains}/${barracksCap} (S:${soldiers} C:${captains})`;
    equipEl.textContent = `Sword:${state.equipment.sword} · Shield:${state.equipment.shield}`;

    updateTooltip(state, view);
  }

  return { update, flash };
}
