// HUD layer (req §2.2, §19). Reads GameState and reflects it into the HTML
// overlay (resource bar, pooled storage, season/timer, population caps,
// equipment counts, build menu). Read-only with respect to simulation state;
// the Save/Load/New buttons invoke caller-supplied callbacks rather than
// touching state directly.

import {
  BARRACKS_HOUSING_CAPACITY,
  BUILD_TICKS,
  CRAFT_TICKS,
  GAME_SPEEDS,
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
import { diceRange, unitAttackRange, unitDefense } from "../game/combat.js";
import { upcomingIcon, upcomingLabel } from "../game/events.js";
import { poolTotal, RESOURCE_TYPES, type ResourceType } from "../game/resources.js";
import { deriveSeason, type GameNotification, type GameState } from "../game/state.js";
import { hasHorse, maxHp, type Order } from "../game/units.js";
import type { View } from "./camera.js";

export interface HudCallbacks {
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
  // an enemy sighting pauses the game; clicking its toast jumps the camera
  // to the combat (and unpauses, since the player is now looking at it).
  onPause: () => void;
  onJumpTo: (x: number, y: number) => void;
  // Set the game-speed multiplier (req §15.4).
  onSetSpeed: (speed: number) => void;
}

export interface Hud {
  update: (state: GameState, paused: boolean, view: View, speed: number) => void;
  flash: (message: string) => void;
}

// Compact label for a speed multiplier: ¼× · ½× · 1× · 2× · 4×.
function speedLabel(speed: number): string {
  if (speed === 0.25) return "¼×";
  if (speed === 0.5) return "½×";
  return `${speed}×`;
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
    case "mount":
      return "Going to mount";
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

// Building hover tooltip content: name, health, and whatever stats apply
// to the kind — storage/housing contribution, in-progress craft/train/spawn, or
// a mine's rolled yield.
function describeBuilding(state: GameState, b: Building): { title: string; lines: string[] } {
  const title = BUILDING_LABEL[b.kind];
  const lines: string[] = [];

  if (!isBuilt(b)) {
    lines.push(`Under construction ${pct(b.progress, BUILD_TICKS[b.kind])}%`);
    lines.push(`HP ${Math.round(b.hp)}/${b.maxHp}`);
    return { title, lines };
  }

  lines.push(`HP ${Math.round(b.hp)}/${b.maxHp}`);
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
      if (b.craftItem) lines.push(`Crafting ${b.craftItem} ${pct(b.craftProgress, CRAFT_TICKS[b.craftItem])}%`);
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
  const eventEl = el("hud-event");
  const pausedEl = el("hud-paused");
  const tickEl = el("hud-tick");
  const resourcesEl = el("hud-resources");
  const storageEl = el("hud-storage");
  const toastEl = el("hud-toast");
  const noticesEl = el("hud-notifications");
  const combatAlertEl = el("hud-combat-alert");
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
  const forestTooltipEl = el("forest-tooltip");
  const ftWood = el("ft-wood");

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

  // Game-speed buttons (req §15.4). Built once; the active one is highlighted
  // each frame from the loop's current multiplier.
  const speedEl = el("hud-speed");
  const speedButtons: Array<[number, HTMLButtonElement]> = [];
  for (const s of GAME_SPEEDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = speedLabel(s);
    btn.addEventListener("click", () => cb.onSetSpeed(s));
    speedEl.append(btn);
    speedButtons.push([s, btn]);
  }
  function updateSpeedButtons(speed: number): void {
    for (const [s, btn] of speedButtons) btn.classList.toggle("active", s === speed);
  }

  // Combat alert: clicking it jumps to the gravest threat and dismisses it.
  let combatJump: { x: number; y: number } | null = null;
  let combatAlertTimer = 0;
  // Whether an attack is currently ongoing (enemies present). Drives the
  // one-shot toast: it re-arms only after the map is cleared of enemies.
  let attackActive = false;
  combatAlertEl.addEventListener("click", () => {
    if (combatJump) cb.onJumpTo(combatJump.x, combatJump.y);
    combatAlertEl.hidden = true;
    window.clearTimeout(combatAlertTimer);
  });

  let toastTimer = 0;
  function flash(message: string): void {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 1500);
  }

  // Sim event popups. The sim appends to state.notifications; we toast each
  // one exactly once, tracking the highest id we've shown. Lazily initialised on
  // the first update so notifications already present in a loaded save (or the
  // initial state) aren't replayed as if they just happened.
  let lastNoticeId = -1;
  let noticesInitialised = false;
  function pushNotice(note: GameNotification): void {
    const div = document.createElement("div");
    div.className = "hud-notice";
    div.textContent = note.message;
    // an enemy notice carries the combat location — make its toast a button
    // that recenters the camera there (the caller also unpauses).
    const jump = note.kind === "enemy" && note.x !== undefined && note.y !== undefined;
    if (jump) {
      div.classList.add("clickable");
      div.addEventListener("click", () => {
        cb.onJumpTo(note.x as number, note.y as number);
        div.remove();
      });
    }
    noticesEl.appendChild(div);
    // Fade out, then remove from the DOM so the stack doesn't grow unbounded.
    // Enemy notices linger longer so the player has time to act on them.
    const life = jump ? 12000 : 5000;
    window.setTimeout(() => div.classList.add("fading"), life);
    window.setTimeout(() => div.remove(), life + 600);
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
      pushNotice(n);
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
    const horseHp = hasHorse(u) ? ` (+${Math.round(u.horseHp)} horse)` : "";
    const atk = diceRange(unitAttackRange(u));
    const def = diceRange(unitDefense(u));
    ttHp.textContent = `HP ${Math.round(u.hp)}/${maxHp(u.kind)}${horseHp} · Atk ${atk.min}-${atk.max} · Def ${def.min}-${def.max}`;
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

  // Forest hover tooltip: how much wood is left to harvest from the tile under
  // the cursor (req §12). Suppressed while a unit or building is hovered.
  function updateForestTooltip(view: View): void {
    if (view.hoveredForestWood === null) {
      forestTooltipEl.hidden = true;
      return;
    }
    const w = view.hoveredForestWood;
    ftWood.textContent = `Wood: ${w} ${w === 1 ? "unit" : "units"}`;
    positionTooltip(forestTooltipEl, view);
    forestTooltipEl.hidden = false;
  }

  // Bottom-centre combat alert: a one-shot toast raised when an attack begins —
  // so an attack far from the camera is never missed — instead of pausing. It
  // auto-hides after 5s, or immediately when clicked (which also jumps the
  // camera). The click points at the enemy nearest the Main Hall (the gravest
  // threat), falling back to the first enemy if the hall is gone. It re-arms
  // only once the map is cleared, so a fresh wave raises it again.
  function updateCombatAlert(state: GameState): void {
    const enemies = Object.values(state.enemies);
    if (enemies.length === 0) {
      if (attackActive) {
        attackActive = false;
        combatAlertEl.hidden = true;
        window.clearTimeout(combatAlertTimer);
        combatJump = null;
      }
      return;
    }
    const hall = Object.values(state.buildings).find((b) => b.kind === "mainHall");
    let target = enemies[0];
    if (hall) {
      let bestD = Infinity;
      for (const e of enemies) {
        const d = (e.x - hall.x) ** 2 + (e.y - hall.y) ** 2;
        if (d < bestD) { bestD = d; target = e; }
      }
    }
    // Keep the jump target current so a click (while the toast is up) points at
    // the gravest threat, even though only the first frame raises the toast.
    combatJump = { x: Math.round(target.x), y: Math.round(target.y) };
    if (attackActive) return;
    attackActive = true;
    const n = enemies.length;
    combatAlertEl.textContent = `⚔️ Under attack! ${n} ${n === 1 ? "enemy" : "enemies"} — click to view`;
    combatAlertEl.hidden = false;
    window.clearTimeout(combatAlertTimer);
    combatAlertTimer = window.setTimeout(() => (combatAlertEl.hidden = true), 5000);
  }

  function update(state: GameState, paused: boolean, view: View, speed: number): void {
    updateSpeedButtons(speed);
    const { season, year, secondsRemaining } = deriveSeason(state.tickCount);
    seasonEl.textContent = `${season}, Year ${year}`;
    timerEl.textContent = `${secondsRemaining}s`;
    // Upcoming end-of-year event (req §16.4): icon + label, only the type known.
    eventEl.textContent = `Next: ${upcomingIcon(state.upcomingEvent)} ${upcomingLabel(state.upcomingEvent)}`;
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
    updateCombatAlert(state);
    updateTooltip(state, view);
    updateBuildingTooltip(state, view);
    updateForestTooltip(view);
  }

  return { update, flash };
}
