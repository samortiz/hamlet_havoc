// HUD layer (req §2.2, §19). Reads GameState and reflects it into the HTML
// overlay (resource bar, pooled storage, season/timer). Read-only with respect
// to simulation state; the Save/Load/New buttons invoke caller-supplied
// callbacks rather than touching state directly.

import { storageCapacity } from "../game/buildings.js";
import { poolTotal, RESOURCE_TYPES, type ResourceType } from "../game/resources.js";
import { deriveSeason, type GameState } from "../game/state.js";

export interface HudCallbacks {
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
}

export interface Hud {
  update: (state: GameState, paused: boolean) => void;
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

export function createHud(cb: HudCallbacks): Hud {
  const seasonEl = el("hud-season");
  const timerEl = el("hud-timer");
  const pausedEl = el("hud-paused");
  const tickEl = el("hud-tick");
  const resourcesEl = el("hud-resources");
  const storageEl = el("hud-storage");
  const toastEl = el("hud-toast");

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

  function update(state: GameState, paused: boolean): void {
    const { season, year, secondsRemaining } = deriveSeason(state.tickCount);
    seasonEl.textContent = `${season}, Year ${year}`;
    timerEl.textContent = `${secondsRemaining}s`;
    tickEl.textContent = `tick ${state.tickCount}`;
    pausedEl.hidden = !paused;

    for (const t of RESOURCE_TYPES) countEls[t].textContent = String(state.resources[t]);
    storageEl.textContent = `Storage ${poolTotal(state.resources)}/${storageCapacity(state.buildings)}`;
  }

  return { update, flash };
}
