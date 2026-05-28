// Worker order systems (req §6.5, §10–§14). Stateless functions that advance a
// unit's order one step and apply the side effects (resource yields, forest
// depletion, mine typing, field changes) onto a mutable per-step context the
// caller assembled from copies of the input state. Nothing here mutates the
// previous GameState; update.ts builds the next one from the mutated context.

import {
  BASE_MOVE_TILES_PER_SEC,
  CROP_GROW_TICKS,
  DIAMOND_CHANCE,
  FISH_TICKS_PER_UNIT,
  HARVEST_TICKS,
  MINE_TYPE_WEIGHTS,
  ORE_TICKS_PER_UNIT,
  PLANT_TICKS,
  PLANT_WHEAT_COST,
  PLOUGH_TICKS,
  TICKS_PER_SECOND,
  WHEAT_YIELD_PER_TILE,
  WOOD_TICKS_PER_UNIT,
} from "../config/index.js";
import { nearestStorage, type Building } from "./buildings.js";
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
import {
  carryCap,
  type FieldAction,
  type GatherResource,
  type Order,
  type Unit,
} from "./units.js";

const TICKS_PER_TILE = TICKS_PER_SECOND / BASE_MOVE_TILES_PER_SEC;
const TILES_PER_TICK = BASE_MOVE_TILES_PER_SEC / TICKS_PER_SECOND;

// Mutable working state for one update() step. The caller owns the copies; these
// functions read and write them freely.
export interface SimCtx {
  map: GameMap; // tiles/forestWood/mineType are copies, safe to mutate
  resources: ResourcePool;
  capacity: number;
  buildings: Record<number, Building>;
  fields: Record<number, Field>;
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
  map: GameMap,
  unit: Unit,
  tx: number,
  ty: number,
): { resource: GatherResource; work: TileCoord } | null {
  const tile = tileAt(map, tx, ty);
  if (tile === "forest") return { resource: "wood", work: { x: tx, y: ty } };
  if (tile === "mountain") return { resource: "ore", work: { x: tx, y: ty } };
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

export function startGather(map: GameMap, unit: Unit, tx: number, ty: number): Order {
  const c = classifyGather(map, unit, tx, ty);
  if (!c) return { type: "idle" };
  const path = pathFromUnit(map, unit, c.work);
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
  const path = pathFromUnit(map, unit, { x: tx, y: ty });
  if (!path) return { type: "idle" };
  return { type: "field", action, tx, ty, phase: "toTile", path, node: 0, workTicks: 0 };
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
    case "ore":
      return tileAt(ctx.map, wx, wy) === "mountain";
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
