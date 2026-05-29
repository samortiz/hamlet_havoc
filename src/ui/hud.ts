// HUD layer (req §2.2, §19). Reads GameState and reflects it into the HTML
// overlay (resource bar, pooled storage, season/timer, population caps,
// equipment counts, build menu). Read-only with respect to simulation state;
// the Save/Load/New buttons invoke caller-supplied callbacks rather than
// touching state directly.

import {
  BARRACKS_HOUSING_CAPACITY,
  BUILD_TICKS,
  CRAFT_TICKS,
  HOUSE_HOUSING_CAPACITY,
  MAP_WIDTH,
  TRAIN_TICKS,
  WORKER_SPAWN_TICKS,
} from "../config/index.js";
import {
  barracksHousingCap,
  unitCount,
  workerHousingCap,
} from "../game/actions.js";
import {
  buildingStorage,
  isBuilt,
  storageCapacity,
  type Building,
  type BuildingKind,
} from "../game/buildings.js";
import { unitAttackRange, unitDefense } from "../game/combat.js";
import { poolTotal, RESOURCE_TYPES, type ResourceType } from "../game/resources.js";
import { deriveSeason, type GameState } from "../game/state.js";
import { hasHorse, maxHp, type Order } from "../game/units.js";
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
      return "Operating";
    case "attack":
      return "Attacking";
    case "trade":
      return order.phase === "toTown" ? "Going to town" : "Trading";
  }
}

const BUILDING_LABEL: Record<BuildingKind, string> = {
  mainHall: "Main Hall",
  house: "House",
  barn: "Barn",
  smithy: "Smithy",
  barracks: "Barracks",
  mine: "Mine",
};

function pct(progress: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((progress / total) * 100));
}

// Building hover tooltip content (T10): name, health, and whatever stats apply
// to the kind — storage/housing contribution, in-progress craft/train/spawn, or
// a mine's rolled yield.
function describeBuilding(state: GameState, b: Building): { title: string; lines: string[] } {
  const title = BUILDING_LABEL[b.kind];
  const lines: string[] = [];

  if (!isBuilt(b)) {
    lines.push(`Under construction ${pct(b.progress, BUILD_TICKS[b.kind])}%`);
    lines.push(`HP ${b.hp}/${b.maxHp}`);
    return { title, lines };
  }

  lines.push(`HP ${b.hp}/${b.maxHp}`);
  const storage = buildingStorage(b.kind);
  if (storage > 0) lines.push(`Storage +${storage}`);

  switch (b.kind) {
    case "house":
      lines.push(`Houses ${HOUSE_HOUSING_CAPACITY} workers`);
      break;
    case "barracks":
      lines.push(`Houses ${BARRACKS_HOUSING_CAPACITY} soldiers/captains`);
      if (b.trainTo) lines.push(`Training → ${b.trainTo} ${pct(b.trainProgress, TRAIN_TICKS)}%`);
      break;
    case "smithy":
      if (b.craftItem) lines.push(`Crafting ${b.craftItem} ${pct(b.craftProgress, CRAFT_TICKS)}%`);
      break;
    case "mine": {
      const mineType = state.map.mineType[b.y * MAP_WIDTH + b.x];
      if (mineType) lines.push(`Yields ${mineType}`);
      break;
    }
    case "mainHall":
      if (b.spawning) lines.push(`Raising worker ${pct(b.spawnProgress, WORKER_SPAWN_TICKS)}%`);
      break;
  }
  return { title, lines };
}

export function createHud(cb: HudCallbacks): Hud {
  const seasonEl = el("hud-season");
  const timerEl = el("hud-timer");
  const pausedEl = el("hud-paused");
  const tickEl = el("hud-tick");
  const resourcesEl = el("hud-resources");
  const storageEl = el("hud-storage");
  const toastEl = el("hud-toast");
  const noticesEl = el("hud-notifications");
  const popEl = el("hud-population");
  const equipEl = el("hud-equipment");
  const tooltipEl = el("unit-tooltip");
  const ttTitle = el("tt-title");
  const ttHp = el("tt-hp");
  const ttOrder = el("tt-order");
  const ttCarry = el("tt-carry");
  const buildingTooltipEl = el("building-tooltip");
  const btTitle = el("bt-title");
  const btBody = el("bt-body");

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

  // Sim event popups (T7). The sim appends to state.notifications; we toast each
  // one exactly once, tracking the highest id we've shown. Lazily initialised on
  // the first update so notifications already present in a loaded save (or the
  // initial state) aren't replayed as if they just happened.
  let lastNoticeId = -1;
  let noticesInitialised = false;
  function pushNotice(message: string): void {
    const div = document.createElement("div");
    div.className = "hud-notice";
    div.textContent = message;
    noticesEl.appendChild(div);
    // Fade out, then remove from the DOM so the stack doesn't grow unbounded.
    window.setTimeout(() => div.classList.add("fading"), 5000);
    window.setTimeout(() => div.remove(), 5600);
  }
  function drainNotifications(state: GameState): void {
    const notes = state.notifications;
    if (!noticesInitialised) {
      // Suppress anything that predates this HUD (e.g. a resumed save).
      for (const n of notes) lastNoticeId = Math.max(lastNoticeId, n.id);
      noticesInitialised = true;
      return;
    }
    for (const n of notes) {
      if (n.id <= lastNoticeId) continue;
      lastNoticeId = n.id;
      pushNotice(n.message);
    }
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

    const title = u.kind.charAt(0).toUpperCase() + u.kind.slice(1);
    ttTitle.textContent = hasHorse(u) ? `${title} 🐴` : title;
    const horseHp = hasHorse(u) ? ` (+${u.horseHp} horse)` : "";
    const atk = unitAttackRange(u);
    ttHp.textContent = `HP ${u.hp}/${maxHp(u.kind)}${horseHp} · Atk ${atk.min}-${atk.max} · Def ${unitDefense(u)}`;
    ttOrder.textContent = describeOrder(u.order);

    const items: string[] = [];
    if (u.equipped.sword) items.push("sword");
    if (u.equipped.shield) items.push("shield");
    for (const t of RESOURCE_TYPES) {
      const v = u.carrying[t] ?? 0;
      if (v > 0) items.push(`${v} ${t}`);
    }
    ttCarry.textContent = items.length ? `Carrying: ${items.join(", ")}` : "";
    ttCarry.hidden = items.length === 0;

    positionTooltip(tooltipEl, view);
    tooltipEl.hidden = false;
  }

  // Position a tooltip near the cursor, flipping left/up near a viewport edge.
  function positionTooltip(elem: HTMLElement, view: View): void {
    const mx = view.mouseScreenX;
    const my = view.mouseScreenY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = 160;
    const th = 90;
    const left = mx + 18 + tw > vw ? mx - tw - 8 : mx + 18;
    const top = my + th > vh ? my - th : my + 10;
    elem.style.left = `${left}px`;
    elem.style.top = `${top}px`;
  }

  function updateBuildingTooltip(state: GameState, view: View): void {
    if (view.hoveredBuildingId === null) {
      buildingTooltipEl.hidden = true;
      return;
    }
    const b = state.buildings[view.hoveredBuildingId];
    if (!b) {
      buildingTooltipEl.hidden = true;
      return;
    }
    const { title, lines } = describeBuilding(state, b);
    btTitle.textContent = title;
    btBody.replaceChildren(
      ...lines.map((line) => {
        const div = document.createElement("div");
        div.textContent = line;
        return div;
      }),
    );
    positionTooltip(buildingTooltipEl, view);
    buildingTooltipEl.hidden = false;
  }

  function update(state: GameState, paused: boolean, view: View): void {
    const { season, year, secondsRemaining } = deriveSeason(state.tickCount);
    seasonEl.textContent = `${season}, Year ${year}`;
    timerEl.textContent = `${secondsRemaining}s`;
    tickEl.textContent = `tick ${state.tickCount}`;
    pausedEl.hidden = !paused;

    const cap = storageCapacity(state.buildings);
    for (const t of RESOURCE_TYPES) countEls[t].textContent = `${state.resources[t]}`;
    storageEl.textContent = `Total ${poolTotal(state.resources)}/${cap}`;

    const workers = unitCount(state.units, "worker");
    const soldiers = unitCount(state.units, "soldier");
    const captains = unitCount(state.units, "captain");
    const workerCap = workerHousingCap(state.buildings);
    // Barracks house soldiers and captains in one shared pool (req §7.4).
    const barracksCap = barracksHousingCap(state.buildings);
    popEl.textContent = `Pop W:${workers}/${workerCap} · S+C:${soldiers + captains}/${barracksCap} (S:${soldiers} C:${captains})`;
    equipEl.textContent = `Sword:${state.equipment.sword} · Shield:${state.equipment.shield}`;

    drainNotifications(state);
    updateTooltip(state, view);
    updateBuildingTooltip(state, view);
  }

  return { update, flash };
}
