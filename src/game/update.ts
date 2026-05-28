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
  startBuild,
  startField,
  startGather,
  startMove,
  startOperate,
  type SimCtx,
} from "./actions.js";
import {
  barracksHousingCap,
  unitCount,
} from "./actions.js";
import {
  isBuilt,
  makeBuilding,
  storageCapacity,
  type Building,
  type BuildingKind,
} from "./buildings.js";
import type { Command } from "./commands.js";
import { makeField, type Field } from "./fields.js";
import type { GameMap } from "./map.js";
import type { EquipmentPool, GameState } from "./state.js";
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
  const equipment: EquipmentPool = { ...state.equipment };

  const map: GameMap = {
    width: state.map.width,
    height: state.map.height,
    tiles: state.map.tiles.slice(),
    forestWood: { ...state.map.forestWood },
    mineType: { ...state.map.mineType },
  };
  const ctx: SimCtx = {
    map,
    resources: { ...state.resources },
    capacity: storageCapacity(buildings),
    buildings,
    fields,
    equipment,
    rngState: state.rngState,
    tickCount: state.tickCount + dtTicks,
    nextId: state.nextEntityId,
  };

  // 1) Commands become unit orders (and possibly new buildings/fields).
  for (const cmd of commands) handleCommand(cmd, ctx, units);

  // 2) Advance every unit's order by dtTicks. We snapshot keys first because
  // building/training can promote a unit (mutating `units` mid-loop is fine
  // since we iterate ids, but the snapshot makes the order explicit).
  for (const key of Object.keys(units)) {
    const id = Number(key);
    units[id] = advanceUnit(units[id], dtTicks, ctx);
  }

  // 3) Per-building work (smithy crafting, barracks training).
  advanceBuildings(ctx, dtTicks, units);

  // 4) Mature any planted crops that have grown long enough.
  advanceFieldGrowth(ctx);

  // Storage capacity can change mid-step if a build completed; keep `capacity`
  // synced so a follow-up deposit (next step) uses the right value.
  ctx.capacity = storageCapacity(ctx.buildings);

  return {
    ...state,
    map,
    units,
    buildings: ctx.buildings,
    fields: ctx.fields,
    resources: ctx.resources,
    equipment: ctx.equipment,
    rngState: ctx.rngState,
    nextEntityId: ctx.nextId,
    tickCount: ctx.tickCount,
  };
}

function handleCommand(cmd: Command, ctx: SimCtx, units: Record<number, Unit>): void {
  if (cmd.type === "moveUnits") {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startMove(ctx.map, u, cmd.tx, cmd.ty) };
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
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      ejectIfInside(u, ctx);
      units[id] = { ...u, insideBuildingId: null, order: startField(ctx.map, u, cmd.action, cmd.tx, cmd.ty) };
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
        order: startBuild(ctx.map, u, b.id, true, { x: b.x, y: b.y }),
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
      units[id] = { ...u, insideBuildingId: null, order: startOperate(ctx.map, u, b, mode) };
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
      units[id] = { ...u, insideBuildingId: null, order: startOperate(ctx.map, u, b, mode) };
      break; // one trainee per barracks
    }
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
        order: startBuild(ctx.map, u, -id, false, { x: cmd.tx, y: cmd.ty }),
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
      order: startBuild(ctx.map, u, id, false, { x: cmd.tx, y: cmd.ty }),
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
