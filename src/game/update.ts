// The simulation core (req §2.6). A stateless, deterministic step:
// update(state, commands, dtTicks) -> newState. Imports nothing from render/ or
// ui/ and touches no DOM, so it runs headless in tests and serializes cleanly.
//
// Each step copies the mutable parts of state into a SimCtx, lets the command
// handlers set unit orders and the action systems advance them (mutating the
// context), then assembles the next immutable GameState. The previous state is
// never mutated.

import {
  advanceBuildings,
  advanceFieldGrowth,
  advanceUnit,
  buildableCost,
  canAfford,
  payCost,
  placementValid,
  processSeasonTransitions,
  applyIdleHealing,
  releaseOccupancy,
  startAttack,
  startBuild,
  startField,
  startGather,
  startMove,
  startOperate,
  startTrade,
  executeHallStore,
  executeTownStore,
  executeTownTrade,
  triggerEvent,
  checkLoss,
  executeTax,
  acknowledgeEvent,
  applyMiscTrade,
  type SimCtx,
} from "./actions.js";
import {
  barracksHousingCap,
  unitCount,
  workerHousingCap,
} from "./actions.js";
import {
  isBuilt,
  makeBuilding,
  storageCapacity,
  type Building,
  type BuildingKind,
} from "./buildings.js";
import { stepCombat, stepEnemyAI, type Enemy } from "./combat.js";
import type { Command } from "./commands.js";
import { makeField, type Field } from "./fields.js";
import type { GameMap } from "./map.js";
import { fieldActionInSeason, seasonAt, seasonBoundaries } from "./season.js";
import { MAX_NOTIFICATIONS, type EquipmentPool, type GameState, type GroundItem } from "./state.js";
import type { CraftItem } from "./buildings.js";
import type { OperateMode, Unit, UnitKind } from "./units.js";

export function update(
  state: GameState,
  commands: readonly Command[],
  dtTicks: number,
): GameState {
  // Shallow copy of every per-step mutable container. The action systems are
  // allowed to write through `units`/`ctx`; the previous GameState is not
  // touched, so the call is pure with respect to its input.
  const units: Record<number, Unit> = { ...state.units };
  const buildings: Record<number, Building> = { ...state.buildings };
  const fields: Record<number, Field> = { ...state.fields };
  const enemies: Record<number, Enemy> = { ...state.enemies };
  const groundItems: Record<number, GroundItem> = { ...state.groundItems };
  const equipment: EquipmentPool = { ...state.equipment };
  const townStorage = { ...state.townStorage };

  const map: GameMap = {
    width: state.map.width,
    height: state.map.height,
    tiles: state.map.tiles.slice(),
    forestWood: { ...state.map.forestWood },
    mineType: { ...state.map.mineType },
    mountainType: { ...state.map.mountainType },
  };
  // A Tax/Misc event opens a modal dialog that fully pauses the world (req §16,
  // §21.1): while phase is `endOfYearEvent` the tick count holds at the boundary
  // *and* the advancement passes below are skipped, so no unit moves, fights, or
  // produces until the player closes the dialog. An Attack event never uses this
  // phase — it spawns its wave and stays in `playing`, so the calendar and all
  // production carry on and the wave is fought live (req §16.1).
  const inEvent = state.phase === "endOfYearEvent";
  const tickAdvance = inEvent ? 0 : dtTicks;

  const ctx: SimCtx = {
    map,
    resources: { ...state.resources },
    capacity: storageCapacity(buildings),
    buildings,
    fields,
    enemies,
    groundItems,
    equipment,
    town: state.town,
    townStorage,
    rngState: state.rngState,
    tickCount: state.tickCount + tickAdvance,
    nextId: state.nextEntityId,
    notifications: state.notifications.slice(),
    // Damage toasts are per-step: start empty so this step only carries the
    // hits it lands, then write them back below for the renderer to float.
    damageEvents: [],
    healEvents: [], // heal toasts this step (req §6.2); same per-step lifecycle

    phase: state.phase,
    upcomingEvent: state.upcomingEvent,
    activeEvent: state.activeEvent,
    eventSchedule: state.eventSchedule.slice(),
    eventMods: { ...state.eventMods },
    stats: { ...state.stats },
  };

  // 1) Commands become unit orders (and possibly new buildings/fields). This
  // pass always runs — it is how the modal's payTax/acknowledgeEvent commands
  // reach the sim and return control to `playing`.
  for (const cmd of commands) handleCommand(cmd, ctx, units);

  // Steps 2–6 are the live world. They are skipped wholesale while a Tax/Misc
  // modal is open (`inEvent`), which is what makes the dialog a true pause: no
  // unit moves, fights, heals, produces, or crosses a season boundary until the
  // player closes it. An attack stays in `playing`, so these all run for it.
  if (!inEvent) {
    // 2) Advance every unit's order by dtTicks. We snapshot keys first because
    // building/training can promote a unit (mutating `units` mid-loop is fine
    // since we iterate ids, but the snapshot makes the order explicit).
    for (const key of Object.keys(units)) {
      const id = Number(key);
      units[id] = advanceUnit(units[id], dtTicks, ctx, units);
    }

    // 3) Per-building work (smithy crafting, barracks training).
    advanceBuildings(ctx, dtTicks, units);

    // 3.5) Enemy AI (req §17.3): land goblins march toward the nearest unit or
    // building before the combat pass swings; water predators hold their tile.
    stepEnemyAI(ctx, units, dtTicks);

    // 4) Combat resolution (req §17.1): adjacent units/enemies trade blows once
    // per second. Runs after movement so a unit that just stepped adjacent (via an
    // attack order or auto-defence) can swing this step. A killed unit frees any
    // building slot it held.
    stepCombat(ctx, units, dtTicks, (u) => releaseOccupancy(ctx, u));

    // 4.5) Idle HP regeneration (req §6.2): wounded units left idle heal 5% of max
    // HP every 5 sec. Runs after combat so this step's hits land first.
    applyIdleHealing(ctx, units, state.tickCount);

    // 5) Mature any planted crops that have grown long enough.
    advanceFieldGrowth(ctx);

    // 6) Settlement (normal play only — not gameOver). For any season boundary
    // this step crossed: upkeep + demotion (§6.3), crop loss at fall's end
    // (§11.5), forest regrowth at spring (§12). Then, at the winter→spring
    // boundary, fire the announced year-end event (§16.0) — which, for a
    // Tax/Misc, flips into the modal phase.
    if (state.phase === "playing") {
      processSeasonTransitions(ctx, state.tickCount, units);
      if (ctx.phase === "playing") {
        const startsYear = seasonBoundaries(state.tickCount, ctx.tickCount).some((b) => b.startsYear);
        if (startsYear) triggerEvent(ctx, units);
      }
    }
  }

  // 7) Loss check (req §21.1): Main Hall destroyed or all workers dead → gameOver.
  // Runs continuously, including mid-attack.
  checkLoss(ctx, units);

  // Run-stat tracking (§21): peak population for the game-over screen.
  const pop = Object.keys(units).length;
  if (pop > ctx.stats.peakPopulation) ctx.stats = { ...ctx.stats, peakPopulation: pop };

  // Storage capacity can change mid-step if a build completed; keep `capacity`
  // synced so a follow-up deposit (next step) uses the right value.
  ctx.capacity = storageCapacity(ctx.buildings);

  return {
    ...state,
    map,
    units,
    buildings: ctx.buildings,
    fields: ctx.fields,
    enemies: ctx.enemies,
    groundItems: ctx.groundItems,
    resources: ctx.resources,
    equipment: ctx.equipment,
    townStorage: ctx.townStorage,
    rngState: ctx.rngState,
    nextEntityId: ctx.nextId,
    tickCount: ctx.tickCount,
    phase: ctx.phase,
    upcomingEvent: ctx.upcomingEvent,
    activeEvent: ctx.activeEvent,
    eventSchedule: ctx.eventSchedule,
    eventMods: ctx.eventMods,
    stats: ctx.stats,
    // Keep only the most recent events so the log (and save) stays bounded.
    notifications: ctx.notifications.slice(-MAX_NOTIFICATIONS),
    // This step's combat damage toasts, handed to the renderer.
    damageEvents: ctx.damageEvents,
    // This step's heal toasts, handed to the renderer (req §6.2).
    healEvents: ctx.healEvents,
  };
}

function handleCommand(cmd: Command, ctx: SimCtx, units: Record<number, Unit>): void {
  if (cmd.type === "moveUnits") {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startMove(ctx.map, u, cmd.tx, cmd.ty, ctx.buildings) };
    }
    return;
  }
  if (cmd.type === "gather") {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startGather(ctx, u, cmd.tx, cmd.ty) };
    }
    return;
  }
  if (cmd.type === "field") {
    // Season lock (req §15.3): reject planting outside spring / harvesting
    // outside fall up front, so the order is never even created.
    if (!fieldActionInSeason(cmd.action, seasonAt(ctx.tickCount))) return;
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startField(ctx.map, u, cmd.action, cmd.tx, cmd.ty, ctx.buildings) };
    }
    return;
  }
  if (cmd.type === "build") {
    handleBuildPlacement(cmd, ctx, units);
    return;
  }
  if (cmd.type === "repair") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b || !isBuilt(b) || b.hp >= b.maxHp) return;
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = {
        ...u,
        insideBuildingId: null,
        order: startBuild(ctx.map, u, b.id, true, { x: b.x, y: b.y }, ctx.buildings),
      };
    }
    return;
  }
  if (cmd.type === "resumeBuild") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b || isBuilt(b)) return; // only unfinished buildings can be resumed
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u || u.kind !== "worker") continue; // §6.1: only workers build
      ejectIfInside(u, ctx);
      units[id] = {
        ...u,
        insideBuildingId: null,
        order: startBuild(ctx.map, u, b.id, false, { x: b.x, y: b.y }, ctx.buildings),
      };
    }
    return;
  }
  if (cmd.type === "demolish") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b) return;
    if (b.kind === "mainHall") return; // loss condition, not user-demolishable
    // Eject any occupant and cancel anyone targeting this building.
    if (b.occupantId !== null) {
      const op = units[b.occupantId];
      if (op) units[b.occupantId] = { ...op, insideBuildingId: null, order: { type: "idle" }, x: b.x, y: b.y };
    }
    for (const key of Object.keys(units)) {
      const uid = Number(key);
      const u = units[uid];
      if ((u.order.type === "build" || u.order.type === "operate") && u.order.buildingId === b.id) {
        units[uid] = { ...u, insideBuildingId: null, order: { type: "idle" } };
      }
    }
    delete ctx.buildings[cmd.buildingId];
    return;
  }
  if (cmd.type === "craft") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b || b.kind !== "smithy" || !isBuilt(b)) return;
    // Smithy busy with someone else? Refuse. The current operator may
    // re-issue craft to switch items though, so allow that case.
    if (b.occupantId !== null && !cmd.unitIds.includes(b.occupantId)) return;
    const mode: OperateMode = cmd.item === "sword" ? "craftSword" : "craftShield";
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      if (u.kind !== "worker") continue; // only workers operate the smithy
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startOperate(ctx.map, u, b, mode, ctx.buildings) };
      break; // one operator only
    }
    return;
  }
  if (cmd.type === "train") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b || b.kind !== "barracks" || !isBuilt(b)) return;
    if (b.occupantId !== null) return; // already training someone (§7.3)
    // Housing gate (§7.4): trainees consume a barracks slot; refuse if full.
    const promotedCount = unitCount(units, "soldier") + unitCount(units, "captain");
    if (promotedCount >= barracksHousingCap(ctx.buildings)) return;
    const mode: OperateMode = cmd.toKind === "soldier" ? "trainSoldier" : "trainCaptain";
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      const validSource: UnitKind | null =
        cmd.toKind === "soldier" ? "worker"
        : cmd.toKind === "captain" ? "soldier"
        : null;
      if (validSource === null || u.kind !== validSource) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startOperate(ctx.map, u, b, mode, ctx.buildings) };
      break; // one trainee per barracks
    }
    return;
  }
  if (cmd.type === "spawnWorker") {
    const b = ctx.buildings[cmd.buildingId];
    if (!b || b.kind !== "mainHall" || !isBuilt(b)) return;
    if (b.spawning) return; // already raising a worker
    // Housing gate (§7.4): a new worker needs a free House slot.
    if (unitCount(units, "worker") >= workerHousingCap(ctx.buildings)) return;
    ctx.buildings[cmd.buildingId] = { ...b, spawning: true, spawnProgress: 0 };
    return;
  }
  if (cmd.type === "attack") {
    if (!ctx.enemies[cmd.targetEnemyId]) return;
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startAttack(ctx, u, cmd.targetEnemyId) };
    }
    return;
  }
  if (cmd.type === "equip") {
    handleEquip(cmd, ctx, units);
    return;
  }
  if (cmd.type === "trade") {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = {
        ...u,
        insideBuildingId: null,
        order: startTrade(ctx.map, ctx.town, u, cmd.sell, cmd.buy, cmd.buyHorse, ctx.buildings),
      };
    }
    return;
  }
  if (cmd.type === "townStore") {
    const u = units[cmd.unitId];
    if (!u) return;
    units[cmd.unitId] = executeTownStore(ctx, u, cmd.resource, cmd.amount, cmd.toStorage);
    return;
  }
  if (cmd.type === "hallStore") {
    const u = units[cmd.unitId];
    const b = ctx.buildings[cmd.buildingId];
    if (!u || !b) return;
    units[cmd.unitId] = executeHallStore(ctx, u, b, cmd.resource, cmd.amount, cmd.toStorage);
    return;
  }
  if (cmd.type === "townTrade") {
    const u = units[cmd.unitId];
    if (!u) return;
    const updated = executeTownTrade(ctx, u, cmd.cart, cmd.buyHorse, cmd.offerUnit, cmd.offerStorage, units);
    if (updated) units[cmd.unitId] = updated;
    return;
  }
  if (cmd.type === "cancel") {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: { type: "idle" } };
    }
    return;
  }
  if (cmd.type === "payTax") {
    // Only valid while a Tax event is resolving (executeTax guards this).
    executeTax(ctx, units, cmd.offerResources, cmd.surrenderBuildingIds, cmd.forfeit);
    return;
  }
  if (cmd.type === "miscTrade") {
    // Valid only while a trade-dialog Misc event is open (applyMiscTrade guards it).
    applyMiscTrade(ctx, units, cmd.offerId);
    return;
  }
  if (cmd.type === "acknowledgeEvent") {
    acknowledgeEvent(ctx);
    return;
  }
}

// Equip/unequip a sword or shield (req §6.4). Instant: pulls from / returns to
// the global equipment pool and toggles the unit's `equipped` flag. Any unit
// kind may equip; equipping eats a carry slot (enforced in carryCap).
function handleEquip(
  cmd: Extract<Command, { type: "equip" }>,
  ctx: SimCtx,
  units: Record<number, Unit>,
): void {
  const item: CraftItem = cmd.item;
  for (const id of cmd.unitIds) {
    const u = units[id];
    if (!u) continue;
    if (cmd.equip) {
      if (u.equipped[item]) continue; // already has one
      if (ctx.equipment[item] <= 0) continue; // none available in the pool
      ctx.equipment[item]--;
      units[id] = { ...u, equipped: { ...u.equipped, [item]: true } };
    } else {
      if (!u.equipped[item]) continue;
      ctx.equipment[item]++;
      units[id] = { ...u, equipped: { ...u.equipped, [item]: false } };
    }
  }
}

function handleBuildPlacement(
  cmd: Extract<Command, { type: "build" }>,
  ctx: SimCtx,
  units: Record<number, Unit>,
): void {
  if (!placementValid(ctx.map, ctx.buildings, ctx.fields, cmd.kind, cmd.tx, cmd.ty)) return;
  const cost = buildableCost(cmd.kind);
  if (!canAfford(ctx.resources, cost)) return;
  payCost(ctx.resources, cost);

  if (cmd.kind === "hayField") {
    const id = ctx.nextId++;
    ctx.fields[id] = makeField(id, cmd.tx, cmd.ty, "hay");
    // Encode "build hay-field F" as negative id in the order. Each builder
    // walks to the field tile and accumulates progress.
    for (const uid of cmd.unitIds) {
      const u = units[uid];
      if (!u || u.kind !== "worker") continue;
      ejectIfInside(u, ctx);
      units[uid] = {
        ...u,
        insideBuildingId: null,
        order: startBuild(ctx.map, u, -id, false, { x: cmd.tx, y: cmd.ty }, ctx.buildings),
      };
    }
    return;
  }

  const id = ctx.nextId++;
  ctx.buildings[id] = makeBuilding(id, cmd.kind as BuildingKind, cmd.tx, cmd.ty);
  for (const uid of cmd.unitIds) {
    const u = units[uid];
    if (!u || u.kind !== "worker") continue;
    ejectIfInside(u, ctx);
    units[uid] = {
      ...u,
      insideBuildingId: null,
      order: startBuild(ctx.map, u, id, false, { x: cmd.tx, y: cmd.ty }, ctx.buildings),
    };
  }
}

// If the unit is currently the occupant of a building, free that slot before
// reassigning its order. Used by every command that overrides the current order.
function ejectIfInside(u: Unit, ctx: SimCtx): void {
  if (u.insideBuildingId === null) return;
  const b = ctx.buildings[u.insideBuildingId];
  if (b && b.occupantId === u.id) {
    ctx.buildings[u.insideBuildingId] = { ...b, occupantId: null };
  }
}
