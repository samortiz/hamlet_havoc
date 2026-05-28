// Unit order systems (req §6.5, §10–§14, §7). Stateless functions that advance
// a unit's order one step and apply the side effects (resource yields, forest
// depletion, mine typing, field changes, building progress, smithy output,
// barracks promotions) onto a mutable per-step context the caller assembled
// from copies of the input state. Nothing here mutates the previous GameState;
// update.ts builds the next one from the mutated context.

import {
  BASE_MOVE_TILES_PER_SEC,
  BUILD_TICKS,
  BUILDING_COST,
  CRAFT_COST,
  CRAFT_TICKS,
  CROP_GROW_TICKS,
  DIAMOND_CHANCE,
  FISH_TICKS_PER_UNIT,
  HARVEST_TICKS,
  HAY_FIELD_BUILD_TICKS,
  HAY_FIELD_COST,
  MINE_TYPE_WEIGHTS,
  ORE_TICKS_PER_UNIT,
  PLANT_TICKS,
  PLANT_WHEAT_COST,
  PLOUGH_TICKS,
  TICKS_PER_SECOND,
  TRAIN_TICKS,
  UNIT_MAX_HP,
  WHEAT_YIELD_PER_TILE,
  WOOD_TICKS_PER_UNIT,
  type BuildCost,
} from "../config/index.js";
import {
  buildingAt,
  isBuilt,
  nearestStorage,
  type Building,
  type BuildingKind,
  type CraftItem,
  type TrainTarget,
} from "./buildings.js";
import type { BuildableKind } from "./commands.js";
import { fieldAt, makeField, type Field } from "./fields.js";
import {
  forestRemaining,
  inBounds,
  isWalkable,
  isWaterAdjacent,
  tileAt,
  type GameMap,
  type MineType,
  type TileCoord,
} from "./map.js";
import { findPath } from "./pathfinding.js";
import { rngNext } from "./rng.js";
import {
  carriedTotal,
  poolTotal,
  RESOURCE_TYPES,
  type ResourcePool,
  type ResourceType,
} from "./resources.js";
import type { EquipmentPool } from "./state.js";
import {
  carryCap,
  type FieldAction,
  type GatherResource,
  type OperateMode,
  type Order,
  type Unit,
  type UnitKind,
} from "./units.js";

const TICKS_PER_TILE = TICKS_PER_SECOND / BASE_MOVE_TILES_PER_SEC;
const TILES_PER_TICK = BASE_MOVE_TILES_PER_SEC / TICKS_PER_SECOND;

// Mutable working state for one update() step. The caller owns the copies; these
// functions read and write them freely.
export interface SimCtx {
  map: GameMap; // tiles/forestWood/mineType are copies, safe to mutate
  resources: ResourcePool;
  capacity: number;
  buildings: Record<number, Building>; // copied each step (req §2.6)
  fields: Record<number, Field>;
  equipment: EquipmentPool;
  rngState: number;
  tickCount: number; // tick count *after* this step (for field timing)
  nextId: number; // entity-id allocator; read back after the step
}

// Walk along `path` from (x,y) consuming up to `tileBudget` tiles of distance.
function stepPath(
  x: number,
  y: number,
  path: TileCoord[],
  node: number,
  tileBudget: number,
): { x: number; y: number; node: number; used: number } {
  let used = 0;
  while (tileBudget > 0 && node < path.length) {
    const t = path[node];
    const dx = t.x - x;
    const dy = t.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) {
      node++;
      continue;
    }
    if (dist <= tileBudget) {
      x = t.x;
      y = t.y;
      node++;
      tileBudget -= dist;
      used += dist;
    } else {
      x += (dx / dist) * tileBudget;
      y += (dy / dist) * tileBudget;
      used += tileBudget;
      tileBudget = 0;
    }
  }
  return { x, y, node, used };
}

function pathFromUnit(map: GameMap, unit: Unit, to: TileCoord): TileCoord[] | null {
  const start = { x: Math.round(unit.x), y: Math.round(unit.y) };
  return findPath(map, start, to);
}

// --- Order construction (called from command handling) ---

export function startMove(map: GameMap, unit: Unit, tx: number, ty: number): Order {
  const path = pathFromUnit(map, unit, { x: tx, y: ty });
  return path && path.length > 0
    ? { type: "move", path, node: 0 }
    : { type: "idle" };
}

function classifyGather(
  ctx: SimCtx,
  unit: Unit,
  tx: number,
  ty: number,
): { resource: GatherResource; work: TileCoord } | null {
  const map = ctx.map;
  const tile = tileAt(map, tx, ty);
  if (tile === "forest") return { resource: "wood", work: { x: tx, y: ty } };
  if (tile === "mountain") {
    // M3: mining requires a built Mine on the mountain tile (req §13).
    const mine = buildingAt(ctx.buildings, tx, ty);
    if (!mine || mine.kind !== "mine" || !isBuilt(mine)) return null;
    return { resource: "ore", work: { x: tx, y: ty } };
  }
  if (tile === "water") {
    // Fish from a reachable land tile adjacent to the water (req §14). Prefer the
    // neighbour closest to the unit that has a valid path.
    const neighbours: TileCoord[] = [
      { x: tx + 1, y: ty },
      { x: tx - 1, y: ty },
      { x: tx, y: ty + 1 },
      { x: tx, y: ty - 1 },
    ].sort(
      (a, b) =>
        (a.x - unit.x) ** 2 + (a.y - unit.y) ** 2 -
        ((b.x - unit.x) ** 2 + (b.y - unit.y) ** 2),
    );
    for (const n of neighbours) {
      if (!inBounds(map, n.x, n.y) || !isWalkable(map, n.x, n.y)) continue;
      if (pathFromUnit(map, unit, n) !== null) return { resource: "fish", work: n };
    }
    return null;
  }
  return null;
}

export function startGather(ctx: SimCtx, unit: Unit, tx: number, ty: number): Order {
  const c = classifyGather(ctx, unit, tx, ty);
  if (!c) return { type: "idle" };
  // Only workers can chop wood (req §6.1: soldiers can't plant or chop wood).
  if (c.resource === "wood" && unit.kind !== "worker") return { type: "idle" };
  // Mining + fishing are open to workers and soldiers; captains carry nothing.
  if (unit.kind === "captain") return { type: "idle" };
  const path = pathFromUnit(ctx.map, unit, c.work);
  if (!path) return { type: "idle" };
  return {
    type: "gather",
    resource: c.resource,
    wx: c.work.x,
    wy: c.work.y,
    phase: "toWork",
    path,
    node: 0,
    workTicks: 0,
    storeId: null,
  };
}

export function startField(
  map: GameMap,
  unit: Unit,
  action: FieldAction,
  tx: number,
  ty: number,
): Order {
  if (unit.kind !== "worker") return { type: "idle" }; // §6.1: only workers
  const path = pathFromUnit(map, unit, { x: tx, y: ty });
  if (!path) return { type: "idle" };
  return { type: "field", action, tx, ty, phase: "toTile", path, node: 0, workTicks: 0 };
}

export function startBuild(
  map: GameMap,
  unit: Unit,
  buildingId: number,
  repair: boolean,
  target: TileCoord,
): Order {
  if (unit.kind !== "worker") return { type: "idle" }; // §6.1: only workers build
  const path = pathFromUnit(map, unit, target);
  if (!path) return { type: "idle" };
  return { type: "build", buildingId, repair, phase: "toSite", path, node: 0 };
}

export function startOperate(
  map: GameMap,
  unit: Unit,
  building: Building,
  mode: OperateMode,
): Order {
  const path = pathFromUnit(map, unit, { x: building.x, y: building.y });
  if (!path) return { type: "idle" };
  return {
    type: "operate",
    buildingId: building.id,
    mode,
    phase: "toBuilding",
    path,
    node: 0,
    storeId: null,
  };
}

// --- Placement & costing (req §7.1, §7) ---

export function buildableCost(kind: BuildableKind): BuildCost {
  return kind === "hayField" ? HAY_FIELD_COST : BUILDING_COST[kind as BuildingKind];
}

export function placementValid(
  map: GameMap,
  buildings: Record<number, Building>,
  fields: Record<number, Field>,
  kind: BuildableKind,
  x: number,
  y: number,
): boolean {
  if (!inBounds(map, x, y)) return false;
  if (buildingAt(buildings, x, y)) return false;
  if (fieldAt(fields, x, y)) return false;
  const t = tileAt(map, x, y);
  // Mines must sit on mountain; everything else needs grass/stump (§7.1).
  if (kind === "mine") return t === "mountain";
  return t === "grass" || t === "stump";
}

export function canAfford(pool: ResourcePool, cost: BuildCost): boolean {
  for (const k of Object.keys(cost) as ResourceType[]) {
    if ((pool[k] ?? 0) < (cost[k] ?? 0)) return false;
  }
  return true;
}

export function payCost(pool: ResourcePool, cost: BuildCost): void {
  for (const k of Object.keys(cost) as ResourceType[]) {
    pool[k] -= cost[k] ?? 0;
  }
}

// --- RNG-backed mining helpers ---

function rollMineType(ctx: SimCtx): MineType {
  const [s, v] = rngNext(ctx.rngState);
  ctx.rngState = s;
  if (v < MINE_TYPE_WEIGHTS.stone) return "stone";
  if (v < MINE_TYPE_WEIGHTS.stone + MINE_TYPE_WEIGHTS.iron) return "iron";
  return "gold";
}

function oreYield(ctx: SimCtx, idx: number): ResourceType {
  let type = ctx.map.mineType[idx];
  if (type === undefined) {
    type = rollMineType(ctx);
    ctx.map.mineType[idx] = type;
  }
  if (type === "stone") return "stone";
  if (type === "iron") return "iron";
  // gold mine: small chance of a diamond instead (req §13.2)
  const [s, v] = rngNext(ctx.rngState);
  ctx.rngState = s;
  return v < DIAMOND_CHANCE ? "diamond" : "gold";
}

const GATHER_INTERVAL: Record<GatherResource, number> = {
  wood: WOOD_TICKS_PER_UNIT,
  fish: FISH_TICKS_PER_UNIT,
  ore: ORE_TICKS_PER_UNIT,
};

function workTileValid(
  ctx: SimCtx,
  resource: GatherResource,
  wx: number,
  wy: number,
): boolean {
  const W = ctx.map.width;
  switch (resource) {
    case "wood":
      return tileAt(ctx.map, wx, wy) === "forest" && forestRemaining(ctx.map, wy * W + wx) > 0;
    case "ore": {
      // Mine must still exist and be built (operator's mine wasn't demolished).
      const mine = buildingAt(ctx.buildings, wx, wy);
      return !!mine && mine.kind === "mine" && isBuilt(mine);
    }
    case "fish":
      return isWaterAdjacent(ctx.map, wx, wy);
  }
}

// Produce one unit of the resource into `carrying`, applying map/rng side effects.
function produceYield(
  ctx: SimCtx,
  resource: GatherResource,
  wx: number,
  wy: number,
  carrying: Record<string, number>,
): void {
  const W = ctx.map.width;
  if (resource === "wood") {
    const idx = wy * W + wx;
    carrying.wood = (carrying.wood ?? 0) + 1;
    const left = forestRemaining(ctx.map, idx) - 1;
    ctx.map.forestWood[idx] = left;
    if (left <= 0) ctx.map.tiles[idx] = "stump"; // depleted → stump (req §12)
  } else if (resource === "fish") {
    carrying.meat = (carrying.meat ?? 0) + 1;
  } else {
    const idx = wy * W + wx;
    const res = oreYield(ctx, idx);
    carrying[res] = (carrying[res] ?? 0) + 1;
  }
}

// --- Per-unit order advancement ---

export function advanceUnit(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  switch (unit.order.type) {
    case "idle":
      return unit;
    case "move":
      return advanceMove(unit, dtTicks);
    case "gather":
      return advanceGather(unit, dtTicks, ctx);
    case "field":
      return advanceField(unit, dtTicks, ctx);
    case "build":
      return advanceBuild(unit, dtTicks, ctx);
    case "operate":
      return advanceOperate(unit, dtTicks, ctx);
  }
}

function advanceMove(unit: Unit, dtTicks: number): Unit {
  const o = unit.order;
  if (o.type !== "move") return unit;
  const r = stepPath(unit.x, unit.y, o.path, o.node, TILES_PER_TICK * dtTicks);
  if (r.node >= o.path.length) return { ...unit, x: r.x, y: r.y, order: { type: "idle" } };
  return { ...unit, x: r.x, y: r.y, order: { type: "move", path: o.path, node: r.node } };
}

function advanceGather(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "gather") return unit;

  let x = unit.x;
  let y = unit.y;
  const carrying: Record<string, number> = { ...unit.carrying };
  let { phase, path, node, workTicks, storeId } = o;
  const { resource, wx, wy } = o;
  let timeLeft = dtTicks;
  const cap = carryCap(unit);

  for (let guard = 0; guard < 64 && timeLeft > 0; guard++) {
    if (phase === "toWork" || phase === "toStore") {
      const r = stepPath(x, y, path, node, timeLeft * TILES_PER_TICK);
      x = r.x;
      y = r.y;
      node = r.node;
      timeLeft -= r.used * TICKS_PER_TILE;
      if (node < path.length) break; // still travelling; time spent
      phase = phase === "toWork" ? "working" : "storing";
    } else if (phase === "working") {
      if (!workTileValid(ctx, resource, wx, wy)) {
        if (carriedTotal(carrying) > 0) {
          const setup = toStore(ctx, x, y);
          if (!setup) return idle(unit, x, y, carrying);
          path = setup.path;
          node = 0;
          storeId = setup.storeId;
          phase = "toStore";
          continue;
        }
        return idle(unit, x, y, carrying);
      }
      const interval = GATHER_INTERVAL[resource];
      // Only consume the time we actually need to fill the cap; leave the rest
      // for subsequent phases (move-to-store, deposit, return) so a bulk update
      // can flow through a full cycle in one call.
      const yieldsLeft = cap - carriedTotal(carrying);
      const neededTicks = Math.max(0, yieldsLeft * interval - workTicks);
      const consume = Math.min(timeLeft, neededTicks);
      workTicks += consume;
      timeLeft -= consume;
      while (workTicks >= interval && carriedTotal(carrying) < cap) {
        if (!workTileValid(ctx, resource, wx, wy)) break;
        workTicks -= interval;
        produceYield(ctx, resource, wx, wy, carrying);
      }
      const full = carriedTotal(carrying) >= cap;
      const exhausted = !workTileValid(ctx, resource, wx, wy);
      if (full || exhausted) {
        if (carriedTotal(carrying) === 0) return idle(unit, x, y, carrying);
        workTicks = 0;
        const setup = toStore(ctx, x, y);
        if (!setup) return idle(unit, x, y, carrying);
        path = setup.path;
        node = 0;
        storeId = setup.storeId;
        phase = "toStore";
      } else if (timeLeft <= 0) {
        break; // still gathering, but out of time this step
      }
    } else {
      // storing: deposit into the pool up to capacity, then resume or stop.
      deposit(ctx, carrying);
      if (carriedTotal(carrying) > 0) return idle(unit, x, y, carrying); // pool full
      const back = pathFromUnit(ctx.map, { ...unit, x, y }, { x: wx, y: wy });
      if (!back) return idle(unit, x, y, carrying);
      path = back;
      node = 0;
      storeId = null;
      phase = "toWork";
    }
  }

  return {
    ...unit,
    x,
    y,
    carrying,
    order: { type: "gather", resource, wx, wy, phase, path, node, workTicks, storeId },
  };
}

function toStore(ctx: SimCtx, x: number, y: number): { path: TileCoord[]; storeId: number } | null {
  const b = nearestStorage(ctx.buildings, x, y);
  if (!b) return null;
  const path = findPath(ctx.map, { x: Math.round(x), y: Math.round(y) }, { x: b.x, y: b.y });
  if (!path) return null;
  return { path, storeId: b.id };
}

function deposit(ctx: SimCtx, carrying: Record<string, number>): void {
  let space = ctx.capacity - poolTotal(ctx.resources);
  for (const t of RESOURCE_TYPES) {
    const have = carrying[t] ?? 0;
    if (have <= 0 || space <= 0) continue;
    const put = Math.min(have, space);
    ctx.resources[t] += put;
    carrying[t] = have - put;
    space -= put;
  }
}

function idle(unit: Unit, x: number, y: number, carrying: Record<string, number>): Unit {
  return { ...unit, x, y, carrying, order: { type: "idle" } };
}

function advanceField(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "field") return unit;

  let x = unit.x;
  let y = unit.y;
  let { phase, node, workTicks } = o;
  const { action, tx, ty, path } = o;
  let timeLeft = dtTicks;

  if (phase === "toTile") {
    const r = stepPath(x, y, path, node, timeLeft * TILES_PER_TICK);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * TICKS_PER_TILE;
    if (node >= path.length) phase = "working";
  }

  if (phase === "working" && timeLeft > 0) {
    workTicks += timeLeft;
    if (workTicks >= FIELD_DURATION[action]) {
      completeField(ctx, action, tx, ty);
      return { ...unit, x, y, order: { type: "idle" } };
    }
  }

  return {
    ...unit,
    x,
    y,
    order: { type: "field", action, tx, ty, phase, path, node, workTicks },
  };
}

const FIELD_DURATION: Record<FieldAction, number> = {
  plough: PLOUGH_TICKS,
  plant: PLANT_TICKS,
  harvest: HARVEST_TICKS,
};

function completeField(ctx: SimCtx, action: FieldAction, tx: number, ty: number): void {
  if (action === "plough") {
    const tile = tileAt(ctx.map, tx, ty);
    if ((tile === "grass" || tile === "stump") && !fieldAt(ctx.fields, tx, ty)) {
      const id = ctx.nextId++;
      ctx.fields[id] = makeField(id, tx, ty);
    }
    return;
  }
  const field = fieldAt(ctx.fields, tx, ty);
  if (!field) return;
  if (action === "plant") {
    if (field.stage === "ploughed" && ctx.resources.wheat >= PLANT_WHEAT_COST) {
      ctx.resources.wheat -= PLANT_WHEAT_COST;
      ctx.fields[field.id] = { ...field, stage: "planted", plantedTick: ctx.tickCount };
    }
  } else {
    // harvest
    if (field.stage === "grown") {
      const space = ctx.capacity - poolTotal(ctx.resources);
      ctx.resources.wheat += Math.min(WHEAT_YIELD_PER_TILE, Math.max(0, space));
      ctx.fields[field.id] = { ...field, stage: "ploughed" }; // replantable
    }
  }
}

// Mature planted crops once they have grown long enough (req §11). M2 uses a
// fixed tick duration; M4 replaces this with season-gated growth.
export function advanceFieldGrowth(ctx: SimCtx): void {
  for (const f of Object.values(ctx.fields)) {
    if (f.stage === "planted" && ctx.tickCount - f.plantedTick >= CROP_GROW_TICKS) {
      ctx.fields[f.id] = { ...f, stage: "grown" };
    }
  }
}

// --- Build / repair (req §7, §7.1) ---
//
// The build order targets either a Building (positive id) or a hay-field tile
// feature (encoded as the *negative* of the Field id, so the order shape can
// stay flat). advanceBuild routes to the right branch and accumulates progress
// at 1 tick per builder per simulation tick — two workers on the same site
// finish twice as fast.

function advanceBuild(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "build") return unit;
  const { buildingId, repair, path } = o;
  let { phase, node } = o;
  let x = unit.x;
  let y = unit.y;
  let timeLeft = dtTicks;

  // Walk-to-site is the same regardless of target type.
  if (phase === "toSite") {
    const r = stepPath(x, y, path, node, timeLeft * TILES_PER_TICK);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * TICKS_PER_TILE;
    if (node >= path.length) phase = "working";
  }

  if (buildingId >= 0) {
    // Building target.
    const b = ctx.buildings[buildingId];
    if (!b) return { ...unit, x, y, order: { type: "idle" } };
    if (phase === "working" && timeLeft > 0) {
      if (repair) {
        const totalTicks = BUILD_TICKS[b.kind];
        const hpPerTick = b.maxHp / totalTicks;
        const newHp = Math.min(b.maxHp, b.hp + hpPerTick * timeLeft);
        ctx.buildings[buildingId] = { ...b, hp: newHp };
        if (newHp >= b.maxHp) return { ...unit, x, y, order: { type: "idle" } };
      } else {
        const totalTicks = BUILD_TICKS[b.kind];
        const newProgress = Math.min(totalTicks, b.progress + timeLeft);
        const justFinished = b.progress < totalTicks && newProgress >= totalTicks;
        ctx.buildings[buildingId] = { ...b, progress: newProgress };
        if (justFinished && b.kind === "mine") {
          // Mine type rolled at completion (req §13.1).
          const W = ctx.map.width;
          const idx = b.y * W + b.x;
          if (ctx.map.mineType[idx] === undefined) {
            ctx.map.mineType[idx] = rollMineType(ctx);
          }
        }
        if (newProgress >= totalTicks) return { ...unit, x, y, order: { type: "idle" } };
      }
    }
  } else {
    // Hay-field target. buildingId is `-fieldId`.
    const fid = -buildingId;
    const f = ctx.fields[fid];
    if (!f || f.stage !== "hayBuilding") {
      return { ...unit, x, y, order: { type: "idle" } };
    }
    if (phase === "working" && timeLeft > 0) {
      const newProgress = Math.min(HAY_FIELD_BUILD_TICKS, f.buildProgress + timeLeft);
      const matured = newProgress >= HAY_FIELD_BUILD_TICKS;
      ctx.fields[fid] = {
        ...f,
        buildProgress: newProgress,
        stage: matured ? "hayMature" : "hayBuilding",
      };
      if (matured) return { ...unit, x, y, order: { type: "idle" } };
    }
  }

  return { ...unit, x, y, order: { type: "build", buildingId, repair, phase, path, node } };
}

// --- Operate: smithy crafting / barracks training (req §7.2, §7.3) ---

function advanceOperate(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "operate") return unit;
  const b = ctx.buildings[o.buildingId];
  if (!b || !isBuilt(b)) {
    // Building was demolished or isn't ready; clear and return.
    return { ...unit, insideBuildingId: null, order: { type: "idle" } };
  }

  let x = unit.x;
  let y = unit.y;
  let { phase, node, storeId } = o;
  const { buildingId, mode, path } = o;
  let timeLeft = dtTicks;

  if (phase === "toBuilding") {
    const r = stepPath(x, y, path, node, timeLeft * TILES_PER_TICK);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * TICKS_PER_TILE;
    if (node >= path.length) {
      // Try to claim the building. If it's already occupied by someone else,
      // wait (idle) — the player can re-issue the command later.
      if (b.occupantId !== null && b.occupantId !== unit.id) {
        return { ...unit, x, y, order: { type: "idle" } };
      }
      ctx.buildings[buildingId] = { ...b, occupantId: unit.id };
      phase = "inside";
    }
  }

  // While inside, the building-level pass (advanceBuildings) is what actually
  // ticks craft/train progress. The unit just stays here until ejected by
  // training completion or a cancel command.
  if (phase === "inside") {
    // Mode validation: smithy must be a smithy, barracks must be a barracks.
    const ok =
      (mode === "craftSword" || mode === "craftShield") ? b.kind === "smithy"
      : (mode === "trainSoldier" || mode === "trainCaptain") ? b.kind === "barracks"
      : false;
    if (!ok) {
      // Wrong building type — eject.
      ctx.buildings[buildingId] = { ...b, occupantId: null };
      return { ...unit, x: b.x, y: b.y, insideBuildingId: null, order: { type: "idle" } };
    }
  }

  return {
    ...unit,
    x,
    y,
    insideBuildingId: phase === "inside" ? buildingId : null,
    order: { type: "operate", buildingId, mode, phase, path, node, storeId },
  };
}

// --- Building-level per-step pass (req §7.2, §7.3) ---
// Advances craft/train progress on every building that has an occupant. Splits
// cleanly from the per-unit pass: the unit just sits inside; the building does
// the work and posts results (equipment counters, kind transitions).

export function advanceBuildings(
  ctx: SimCtx,
  dtTicks: number,
  units: Record<number, Unit>,
): void {
  for (const key of Object.keys(ctx.buildings)) {
    const id = Number(key);
    const b = ctx.buildings[id];
    if (!isBuilt(b)) continue;
    if (b.occupantId === null) continue;
    const op = units[b.occupantId];
    if (!op || op.insideBuildingId !== id) continue;

    if (b.kind === "smithy") tickSmithy(ctx, id, dtTicks, op);
    else if (b.kind === "barracks") tickBarracks(ctx, id, dtTicks, units);
  }
}

function tickSmithy(ctx: SimCtx, id: number, dtTicks: number, op: Unit): void {
  let b = ctx.buildings[id];
  // The order is what tells the smithy which item to make; the operator's
  // order is the source of truth so cancellation is a single edit.
  const order = op.order;
  if (order.type !== "operate") return;
  const item: CraftItem | null =
    order.mode === "craftSword" ? "sword"
    : order.mode === "craftShield" ? "shield"
    : null;
  if (!item) return;
  if (b.craftItem !== item) {
    // Operator switched item or just arrived: reset progress to the new item.
    b = { ...b, craftItem: item, craftProgress: 0 };
    ctx.buildings[id] = b;
  }
  let remaining = dtTicks;
  while (remaining > 0) {
    const need = CRAFT_TICKS - b.craftProgress;
    if (remaining < need) {
      ctx.buildings[id] = { ...b, craftProgress: b.craftProgress + remaining };
      return;
    }
    // One item's worth of progress has accumulated. Deduct cost if we can
    // afford it and post the output; otherwise stall progress at the cap.
    const cost = CRAFT_COST[item];
    if (!canAfford(ctx.resources, cost)) {
      ctx.buildings[id] = { ...b, craftProgress: CRAFT_TICKS };
      return;
    }
    payCost(ctx.resources, cost);
    ctx.equipment[item]++;
    remaining -= need;
    b = { ...b, craftProgress: 0 };
    ctx.buildings[id] = b;
  }
}

function tickBarracks(
  ctx: SimCtx,
  id: number,
  dtTicks: number,
  units: Record<number, Unit>,
): void {
  let b = ctx.buildings[id];
  if (b.occupantId === null) return;
  const trainee = units[b.occupantId];
  if (!trainee || trainee.order.type !== "operate") return;
  const targetKind: TrainTarget | null =
    trainee.order.mode === "trainSoldier" ? "soldier"
    : trainee.order.mode === "trainCaptain" ? "captain"
    : null;
  if (!targetKind) return;
  if (b.trainTo !== targetKind) {
    b = { ...b, trainTo: targetKind, trainProgress: 0 };
    ctx.buildings[id] = b;
  }
  const newProgress = b.trainProgress + dtTicks;
  if (newProgress < TRAIN_TICKS) {
    ctx.buildings[id] = { ...b, trainProgress: newProgress };
    return;
  }
  // Training complete (req §7.3). Promote the unit, free the barracks, eject.
  const promotedKind: UnitKind = targetKind;
  const promoted: Unit = {
    ...trainee,
    kind: promotedKind,
    hp: UNIT_MAX_HP[promotedKind],
    insideBuildingId: null,
    order: { type: "idle" },
    x: b.x,
    y: b.y,
  };
  units[trainee.id] = promoted;
  ctx.buildings[id] = { ...b, occupantId: null, trainTo: null, trainProgress: 0 };
}

// --- Housing caps (req §7.4) ---

export function workerHousingCap(buildings: Record<number, Building>): number {
  let cap = 0;
  for (const b of Object.values(buildings)) {
    if (!isBuilt(b)) continue;
    if (b.kind === "house") cap += 2; // HOUSE_HOUSING_CAPACITY
  }
  return cap;
}

export function barracksHousingCap(buildings: Record<number, Building>): number {
  let cap = 0;
  for (const b of Object.values(buildings)) {
    if (!isBuilt(b)) continue;
    if (b.kind === "barracks") cap += 4; // BARRACKS_HOUSING_CAPACITY
  }
  return cap;
}

export function unitCount(units: Record<number, Unit>, kind: UnitKind): number {
  let n = 0;
  for (const u of Object.values(units)) if (u.kind === kind) n++;
  return n;
}
