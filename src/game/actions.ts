// Unit order systems (req §6.5, §10–§14, §7). Stateless functions that advance
// a unit's order one step and apply the side effects (resource yields, forest
// depletion, mine typing, field changes, building progress, smithy output,
// barracks promotions) onto a mutable per-step context the caller assembled
// from copies of the input state. Nothing here mutates the previous GameState;
// update.ts builds the next one from the mutated context.

import {
  BARRACKS_HOUSING_CAPACITY,
  BASE_MOVE_TILES_PER_SEC,
  BUILD_TICKS,
  BUILDING_COST,
  CRAFT_COST,
  CRAFT_TICKS,
  CROP_GROW_TICKS,
  DIAMOND_CHANCE,
  FISH_TICKS_BY_SEASON,
  FISH_TICKS_PER_UNIT,
  HARVEST_TICKS,
  HAY_FIELD_BUILD_TICKS,
  HAY_FIELD_COST,
  HORSE_BONUS_HP,
  HORSE_COST_VALUE,
  HORSE_SPEED_MULT,
  HORSE_UPKEEP,
  HOUSE_HOUSING_CAPACITY,
  MINE_TYPE_WEIGHTS_BY_MOUNTAIN,
  ORE_TICKS_PER_UNIT,
  PLANT_TICKS,
  PLANT_WHEAT_COST,
  PLOUGH_TICKS,
  SEASONS,
  TICKS_PER_SECOND,
  TRAIN_TICKS,
  UNIT_MAX_HP,
  UPKEEP,
  WHEAT_HARVEST_MAX,
  WHEAT_HARVEST_MIN,
  WOOD_ROAM_RADIUS,
  WOOD_TICKS_PER_UNIT,
  WORKER_SPAWN_TICKS,
  type BuildCost,
} from "../config/index.js";
import { fieldActionInSeason, seasonAt, seasonBoundaries } from "./season.js";
import {
  buildingAt,
  isBuilt,
  isStorage,
  nearestStorage,
  type Building,
  type BuildingKind,
  type CraftItem,
  type TrainTarget,
} from "./buildings.js";
import type { Enemy } from "./combat.js";
import type { BuildableKind } from "./commands.js";
import { fieldAt, makeField, type Field } from "./fields.js";
import { hexDistance, hexNeighbors } from "./hex.js";
import {
  forestRemaining,
  inBounds,
  isWalkable,
  isWaterAdjacent,
  mountainTypeAt,
  tileAt,
  type GameMap,
  type MineType,
  type TileCoord,
} from "./map.js";
import { findPath } from "./pathfinding.js";
import { rngNext } from "./rng.js";
import {
  carriedTotal,
  inventoryValue,
  poolTotal,
  RESOURCE_TYPES,
  RESOURCE_VALUE,
  type Inventory,
  type ResourcePool,
  type ResourceType,
} from "./resources.js";
import type { EquipmentPool, GameNotification, NotificationKind } from "./state.js";
import {
  carryCap,
  hasHorse,
  makeWorker,
  type FieldAction,
  type GatherResource,
  type OperateMode,
  type Order,
  type Unit,
  type UnitKind,
} from "./units.js";

const TICKS_PER_TILE = TICKS_PER_SECOND / BASE_MOVE_TILES_PER_SEC;
const TILES_PER_TICK = BASE_MOVE_TILES_PER_SEC / TICKS_PER_SECOND;

// Movement speed for a unit (req §9): a live horse doubles base speed. Returned
// as both tiles-per-tick (path budget) and ticks-per-tile (time charged for the
// distance walked), so every mover can stay horse-aware with one lookup.
function moveSpeed(u: Unit): { tilesPerTick: number; ticksPerTile: number } {
  const mult = hasHorse(u) ? HORSE_SPEED_MULT : 1;
  return { tilesPerTick: TILES_PER_TICK * mult, ticksPerTile: TICKS_PER_TILE / mult };
}

// Mutable working state for one update() step. The caller owns the copies; these
// functions read and write them freely.
export interface SimCtx {
  map: GameMap; // tiles/forestWood/mineType are copies, safe to mutate
  resources: ResourcePool;
  capacity: number;
  buildings: Record<number, Building>; // copied each step (req §2.6)
  fields: Record<number, Field>;
  enemies: Record<number, Enemy>; // copied each step (req §2.6)
  equipment: EquipmentPool;
  town: TileCoord;
  townStorage: ResourcePool; // goods stored at town (req §18); outside the cap
  rngState: number;
  tickCount: number; // tick count *after* this step (for field timing)
  nextId: number; // entity-id allocator; read back after the step
  notifications: GameNotification[]; // player-facing event log (T7); appended in place
}

// Append a player-facing event to the log (T7). Id comes from the shared entity
// counter so the UI can dedup; the caller bounds the list when writing back.
function notify(ctx: SimCtx, kind: NotificationKind, message: string): void {
  ctx.notifications.push({ id: ctx.nextId++, tick: ctx.tickCount, kind, message });
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

function pathFromUnit(
  map: GameMap,
  unit: Unit,
  to: TileCoord,
  buildings: Record<number, Building>,
): TileCoord[] | null {
  const start = { x: Math.round(unit.x), y: Math.round(unit.y) };
  return findPath(map, start, to, buildings);
}

// --- Order construction (called from command handling) ---

export function startMove(
  map: GameMap,
  unit: Unit,
  tx: number,
  ty: number,
  buildings: Record<number, Building>,
): Order {
  const path = pathFromUnit(map, unit, { x: tx, y: ty }, buildings);
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
    // Fish from a reachable land hex adjacent to the water (req §14). On a
    // hex grid that means one of the 6 hex neighbours; pick the closest one
    // (offset-coord Euclidean) that has a valid path from the unit.
    const neighbours = hexNeighbors(tx, ty).sort(
      (a, b) =>
        (a.x - unit.x) ** 2 + (a.y - unit.y) ** 2 -
        ((b.x - unit.x) ** 2 + (b.y - unit.y) ** 2),
    );
    for (const n of neighbours) {
      if (!isWalkable(map, n.x, n.y, ctx.buildings)) continue;
      if (pathFromUnit(map, unit, n, ctx.buildings) !== null) return { resource: "fish", work: n };
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
  const path = pathFromUnit(ctx.map, unit, c.work, ctx.buildings);
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
  buildings: Record<number, Building>,
): Order {
  if (unit.kind !== "worker") return { type: "idle" }; // §6.1: only workers
  const path = pathFromUnit(map, unit, { x: tx, y: ty }, buildings);
  if (!path) return { type: "idle" };
  return { type: "field", action, tx, ty, phase: "toTile", path, node: 0, workTicks: 0 };
}

export function startBuild(
  map: GameMap,
  unit: Unit,
  buildingId: number,
  repair: boolean,
  target: TileCoord,
  buildings: Record<number, Building>,
): Order {
  if (unit.kind !== "worker") return { type: "idle" }; // §6.1: only workers build
  // A Mine sits on a mountain, which is impassable until the mine is built — so
  // the builder can't stand on the tile. When the target itself isn't walkable,
  // build it from an adjacent hex instead (req §13).
  const path = isWalkable(map, target.x, target.y, buildings)
    ? pathFromUnit(map, unit, target, buildings)
    : pathAdjacentTo(map, unit, target.x, target.y, buildings);
  if (!path) return { type: "idle" };
  return { type: "build", buildingId, repair, phase: "toSite", path, node: 0 };
}

export function startOperate(
  map: GameMap,
  unit: Unit,
  building: Building,
  mode: OperateMode,
  buildings: Record<number, Building>,
): Order {
  const path = pathFromUnit(map, unit, { x: building.x, y: building.y }, buildings);
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

// Path from a unit to a walkable hex adjacent to (or on) the target tile. Used
// by attack orders (stop next to the enemy) — prefers the nearest adjacent hex
// with a valid path; falls back to the tile itself if it's reachable.
function pathAdjacentTo(
  map: GameMap,
  unit: Unit,
  tx: number,
  ty: number,
  buildings: Record<number, Building>,
): TileCoord[] | null {
  const neighbours = hexNeighbors(tx, ty)
    .filter((n) => isWalkable(map, n.x, n.y, buildings))
    .sort(
      (a, b) =>
        (a.x - unit.x) ** 2 + (a.y - unit.y) ** 2 -
        ((b.x - unit.x) ** 2 + (b.y - unit.y) ** 2),
    );
  for (const n of neighbours) {
    const p = pathFromUnit(map, unit, n, buildings);
    if (p !== null) return p;
  }
  return pathFromUnit(map, unit, { x: tx, y: ty }, buildings);
}

export function startAttack(ctx: SimCtx, unit: Unit, targetId: number): Order {
  const enemy = ctx.enemies[targetId];
  if (!enemy) return { type: "idle" };
  // Already adjacent? Hold position and let the combat pass do the hitting.
  if (hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, enemy) <= 1) {
    return { type: "attack", targetId, path: [], node: 0 };
  }
  const path = pathAdjacentTo(ctx.map, unit, enemy.x, enemy.y, ctx.buildings);
  if (!path) return { type: "idle" };
  return { type: "attack", targetId, path, node: 0 };
}

export function startTrade(
  map: GameMap,
  town: TileCoord,
  unit: Unit,
  sell: Inventory,
  buy: Inventory,
  buyHorse: boolean,
  buildings: Record<number, Building>,
): Order {
  // Captains carry no resources (§6.1) but may still ride to town for a horse.
  const path = pathFromUnit(map, unit, town, buildings);
  if (!path) return { type: "idle" };
  return { type: "trade", tx: town.x, ty: town.y, sell, buy, buyHorse, phase: "toTown", path, node: 0 };
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

// Roll the mine type for a mountain tile, biased by that mountain's rock type
// (T2, §13.1). idx is the tile index so we can read its MountainType.
function rollMineType(ctx: SimCtx, idx: number): MineType {
  const [s, v] = rngNext(ctx.rngState);
  ctx.rngState = s;
  const w = MINE_TYPE_WEIGHTS_BY_MOUNTAIN[mountainTypeAt(ctx.map, idx)];
  if (v < w.stone) return "stone";
  if (v < w.stone + w.iron) return "iron";
  return "gold";
}

function oreYield(ctx: SimCtx, idx: number): ResourceType {
  let type = ctx.map.mineType[idx];
  if (type === undefined) {
    type = rollMineType(ctx, idx);
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

// Wood roaming (req): once a forest tile is chopped out, a worker hops to the
// nearest forest tile that still has wood within WOOD_ROAM_RADIUS hexes of the
// depleted one and keeps chopping; if none is in range it stops. Only wood roams
// — mines and fishing spots don't deplete. Returns the new work tile plus the
// unit's path to it, or null when nothing reachable is in range.
function nextWoodTile(
  ctx: SimCtx,
  unit: Unit,
  x: number,
  y: number,
  fromX: number,
  fromY: number,
): { wx: number; wy: number; path: TileCoord[] } | null {
  const W = ctx.map.width;
  const max = WOOD_ROAM_RADIUS;
  const from = { x: fromX, y: fromY };
  const candidates: { tx: number; ty: number; d: number }[] = [];
  for (let ty = fromY - max; ty <= fromY + max; ty++) {
    for (let tx = fromX - max; tx <= fromX + max; tx++) {
      if (!inBounds(ctx.map, tx, ty)) continue;
      const d = hexDistance(from, { x: tx, y: ty });
      if (d === 0 || d > max) continue;
      if (tileAt(ctx.map, tx, ty) !== "forest") continue;
      if (forestRemaining(ctx.map, ty * W + tx) <= 0) continue;
      candidates.push({ tx, ty, d });
    }
  }
  // Nearest by hex distance, ties broken by proximity to the worker's position.
  candidates.sort(
    (a, b) =>
      a.d - b.d ||
      (a.tx - x) ** 2 + (a.ty - y) ** 2 - ((b.tx - x) ** 2 + (b.ty - y) ** 2),
  );
  for (const c of candidates) {
    const path = pathFromUnit(ctx.map, { ...unit, x, y }, { x: c.tx, y: c.ty }, ctx.buildings);
    if (path) return { wx: c.tx, wy: c.ty, path };
  }
  return null;
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

// T8: pick an automatic field order for an idle worker standing on a field tile,
// or null if there's nothing to do. Spring → plant a bare ploughed field (only
// when there's seed wheat to spend, mirroring the manual plant); Fall → harvest a
// ripe field. The unit is already on the tile, so the order starts in `working`
// (no path to walk) and the existing advanceField machinery does the timing.
function autoFarmOrder(unit: Unit, ctx: SimCtx): Order | null {
  if (unit.kind !== "worker") return null;
  const tx = Math.round(unit.x);
  const ty = Math.round(unit.y);
  const field = fieldAt(ctx.fields, tx, ty);
  if (!field || field.kind !== "wheat") return null;
  const season = seasonAt(ctx.tickCount);

  let action: FieldAction | null = null;
  if (field.stage === "ploughed" && ctx.resources.wheat >= PLANT_WHEAT_COST) action = "plant";
  else if (field.stage === "grown") action = "harvest";
  if (action === null || !fieldActionInSeason(action, season)) return null;

  return { type: "field", action, tx, ty, phase: "working", path: [], node: 0, workTicks: 0 };
}

export function advanceUnit(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  switch (unit.order.type) {
    case "idle": {
      // T8: a worker left idle on a field tends it automatically — plant in
      // spring, harvest in fall — so staple farming needs no babysitting.
      const auto = autoFarmOrder(unit, ctx);
      return auto ? advanceUnit({ ...unit, order: auto }, dtTicks, ctx) : unit;
    }
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
    case "attack":
      return advanceAttack(unit, dtTicks, ctx);
    case "trade":
      return advanceTrade(unit, dtTicks);
  }
}

function advanceMove(unit: Unit, dtTicks: number): Unit {
  const o = unit.order;
  if (o.type !== "move") return unit;
  const r = stepPath(unit.x, unit.y, o.path, o.node, moveSpeed(unit).tilesPerTick * dtTicks);
  if (r.node >= o.path.length) return { ...unit, x: r.x, y: r.y, order: { type: "idle" } };
  return { ...unit, x: r.x, y: r.y, order: { type: "move", path: o.path, node: r.node } };
}

function advanceGather(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "gather") return unit;

  let x = unit.x;
  let y = unit.y;
  const carrying: Record<string, number> = { ...unit.carrying };
  let { phase, path, node, workTicks, storeId, wx, wy } = o;
  const { resource } = o;
  let timeLeft = dtTicks;
  const cap = carryCap(unit);
  const spd = moveSpeed(unit);

  for (let guard = 0; guard < 64 && timeLeft > 0; guard++) {
    if (phase === "toWork" || phase === "toStore") {
      const r = stepPath(x, y, path, node, timeLeft * spd.tilesPerTick);
      x = r.x;
      y = r.y;
      node = r.node;
      timeLeft -= r.used * spd.ticksPerTile;
      if (node < path.length) break; // still travelling; time spent
      phase = phase === "toWork" ? "working" : "storing";
    } else if (phase === "working") {
      if (!workTileValid(ctx, resource, wx, wy)) {
        // Wood: hop to a nearby tree and keep chopping rather than stop (req).
        if (resource === "wood") {
          const roam = nextWoodTile(ctx, unit, x, y, wx, wy);
          if (roam) {
            wx = roam.wx;
            wy = roam.wy;
            path = roam.path;
            node = 0;
            phase = "toWork";
            continue;
          }
        }
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
      // Fishing rate varies by season (req §14, §15.3): summer bonus, winter
      // penalty. Wood/ore use their fixed intervals.
      const interval = resource === "fish"
        ? FISH_TICKS_BY_SEASON[seasonAt(ctx.tickCount)]
        : GATHER_INTERVAL[resource];
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
      // Chopped this tile out but not yet full: hop to a nearby tree (req) so a
      // half-laden worker keeps filling up instead of trekking back early.
      if (exhausted && !full && resource === "wood") {
        const roam = nextWoodTile(ctx, unit, x, y, wx, wy);
        if (roam) {
          wx = roam.wx;
          wy = roam.wy;
          path = roam.path;
          node = 0;
          phase = "toWork";
          continue;
        }
      }
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
      // Resume at the work tile; if a wood tile got chopped out while we were
      // away, hop to a nearby tree instead of stopping (req).
      if (!workTileValid(ctx, resource, wx, wy)) {
        if (resource !== "wood") return idle(unit, x, y, carrying);
        const roam = nextWoodTile(ctx, unit, x, y, wx, wy);
        if (!roam) return idle(unit, x, y, carrying);
        wx = roam.wx;
        wy = roam.wy;
        path = roam.path;
        node = 0;
        storeId = null;
        phase = "toWork";
        continue;
      }
      const back = pathFromUnit(ctx.map, { ...unit, x, y }, { x: wx, y: wy }, ctx.buildings);
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
  const path = findPath(ctx.map, { x: Math.round(x), y: Math.round(y) }, { x: b.x, y: b.y }, ctx.buildings);
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

  // Season locks (req §15.3) are enforced when the order is *created* (in
  // handleCommand / the UI), so a plant or harvest can only ever start in its
  // legal season. An action already underway is allowed to finish — we don't
  // re-check the season here, which also keeps a fast-forwarded step (whose
  // tickCount jumps past a boundary, §2.10) from cancelling valid work.

  let x = unit.x;
  let y = unit.y;
  let { phase, node, workTicks } = o;
  const { action, tx, ty, path } = o;
  let timeLeft = dtTicks;
  const spd = moveSpeed(unit);

  if (phase === "toTile") {
    const r = stepPath(x, y, path, node, timeLeft * spd.tilesPerTick);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * spd.ticksPerTile;
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
    // harvest — a ripe field yields a random 10–20 wheat (T8), clamped to space.
    if (field.stage === "grown") {
      const space = ctx.capacity - poolTotal(ctx.resources);
      ctx.resources.wheat += Math.min(rollWheatYield(ctx), Math.max(0, space));
      ctx.fields[field.id] = { ...field, stage: "ploughed" }; // replantable
    }
  }
}

// Random wheat yield for one harvested field, in [WHEAT_HARVEST_MIN, MAX] (T8).
// Draws from the seeded sim PRNG so harvests stay deterministic across replays.
function rollWheatYield(ctx: SimCtx): number {
  const [s, v] = rngNext(ctx.rngState);
  ctx.rngState = s;
  const span = WHEAT_HARVEST_MAX - WHEAT_HARVEST_MIN + 1;
  return WHEAT_HARVEST_MIN + Math.floor(v * span);
}

// Mature planted crops once they have grown long enough (req §11). Planting is
// spring-locked, so a one-season grow timer lands the crop in fall, the harvest
// window; anything still unharvested is cleared at fall's end (see crop loss).
export function advanceFieldGrowth(ctx: SimCtx): void {
  for (const f of Object.values(ctx.fields)) {
    if (f.stage === "planted" && ctx.tickCount - f.plantedTick >= CROP_GROW_TICKS) {
      ctx.fields[f.id] = { ...f, stage: "grown" };
    }
  }
}

// --- Season transitions: end-of-season upkeep, crop loss, forest regrowth ---
// (req §6.3, §11, §12, §15). Applied for each season boundary crossed during a
// step. update() passes the tick the step started from; seasonBoundaries() lists
// every boundary reached (usually 0 or 1; more only when fast-forwarded §2.10).

export function processSeasonTransitions(
  ctx: SimCtx,
  prevTick: number,
  units: Record<number, Unit>,
): void {
  for (const b of seasonBoundaries(prevTick, ctx.tickCount)) {
    // End of every season: charge upkeep with the §6.3 demotion ladder.
    chargeUpkeep(ctx, units);
    // End of fall: any wheat not harvested in time is lost (§11.5).
    if (SEASONS[b.endedIndex] === "Fall") loseUnharvestedCrops(ctx);
    // Start of spring: chopped-out forest (stumps) regrows (§12).
    if (b.startsYear) regrowForest(ctx);
  }
}

// Free a unit's building occupancy (smithy operator / barracks trainee / mine
// operator), resetting any in-progress craft/training on that building. Called
// when a unit is removed or demoted at season-end (or killed in combat) so no
// slot is left dangling.
export function releaseOccupancy(ctx: SimCtx, u: Unit): void {
  if (u.insideBuildingId === null) return;
  const b = ctx.buildings[u.insideBuildingId];
  if (b && b.occupantId === u.id) {
    ctx.buildings[u.insideBuildingId] = {
      ...b,
      occupantId: null,
      craftItem: null,
      craftProgress: 0,
      trainTo: null,
      trainProgress: 0,
    };
  }
}

// Worker food (req §6.2: wheat and meat are interchangeable). Prefer meat so the
// pool's wheat — which also doubles as planting seed (§11) — is spent last.
// Returns false if the worker can be fed by neither.
function payWorkerFood(ctx: SimCtx): boolean {
  if (ctx.resources.meat >= UPKEEP.worker) {
    ctx.resources.meat -= UPKEEP.worker;
    return true;
  }
  if (ctx.resources.wheat >= UPKEEP.worker) {
    ctx.resources.wheat -= UPKEEP.worker;
    return true;
  }
  return false;
}

// End-of-season upkeep + demotion ladder (req §6.3). Captains and soldiers are
// charged before workers so they claim their gold/meat first and workers fall
// back to wheat; each unit is charged once, by the rank it held at season-end.
function chargeUpkeep(ctx: SimCtx, units: Record<number, Unit>): void {
  const captains: number[] = [];
  const soldiers: number[] = [];
  const workers: number[] = [];
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.kind === "captain") captains.push(u.id);
    else if (u.kind === "soldier") soldiers.push(u.id);
    else workers.push(u.id);
  }

  // Captain: 1 gold, else demote to soldier.
  for (const id of captains) {
    if (ctx.resources.gold >= UPKEEP.captain) ctx.resources.gold -= UPKEEP.captain;
    else demote(ctx, units, id, "soldier");
  }
  // Soldier: 1 meat, else demote to worker.
  for (const id of soldiers) {
    if (ctx.resources.meat >= UPKEEP.soldier) ctx.resources.meat -= UPKEEP.soldier;
    else demote(ctx, units, id, "worker");
  }
  // Worker: 1 food (meat or wheat), else the worker dies (§6.3 — only workers
  // are permanently lost; higher tiers fall back one rank).
  for (const id of workers) {
    if (!payWorkerFood(ctx)) {
      const u = units[id];
      if (u) releaseOccupancy(ctx, u);
      delete units[id];
      notify(ctx, "death", "A worker starved and was lost — no food for upkeep.");
    }
  }

  // Horse upkeep (§9): each surviving mount eats 2 hay OR 2 wheat per season;
  // an unfed horse dies (its buffer HP is dropped). Charged after unit upkeep so
  // a demoted/killed unit's horse isn't billed.
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.horseHp <= 0) continue;
    if (!payHorseUpkeep(ctx)) {
      units[u.id] = { ...u, horseHp: 0 };
      notify(ctx, "horse", "A horse was lost — no hay or wheat for its upkeep.");
    }
  }
}

// Horse food (§9): 2 hay OR 2 wheat. Prefer hay (its only other use is horses)
// so wheat — also planting seed and worker food — is spent last.
function payHorseUpkeep(ctx: SimCtx): boolean {
  if (ctx.resources.hay >= HORSE_UPKEEP) {
    ctx.resources.hay -= HORSE_UPKEEP;
    return true;
  }
  if (ctx.resources.wheat >= HORSE_UPKEEP) {
    ctx.resources.wheat -= HORSE_UPKEEP;
    return true;
  }
  return false;
}

// Demote a unit one rank (req §6.3). It loses its current job (occupancy freed,
// order cleared) and is reset to the new rank's full HP, mirroring promotion.
function demote(
  ctx: SimCtx,
  units: Record<number, Unit>,
  id: number,
  toKind: UnitKind,
): void {
  const u = units[id];
  if (!u) return;
  releaseOccupancy(ctx, u);
  units[id] = {
    ...u,
    kind: toKind,
    hp: UNIT_MAX_HP[toKind],
    insideBuildingId: null,
    // Captains carry no resources (§6.1); drop anything a demotee was holding.
    carrying: toKind === "captain" ? {} : u.carrying,
    order: { type: "idle" },
  };
  notify(ctx, "demotion", `A ${u.kind} was demoted to ${toKind} — unpaid upkeep.`);
}

// Crop loss (req §11.5): wheat fields still planted or grown when fall ends lose
// their crop and revert to a bare ploughed tile, ready to replant next spring.
function loseUnharvestedCrops(ctx: SimCtx): void {
  for (const f of Object.values(ctx.fields)) {
    if (f.kind === "wheat" && (f.stage === "planted" || f.stage === "grown")) {
      ctx.fields[f.id] = { ...f, stage: "ploughed", plantedTick: 0 };
    }
  }
}

// Forest regrowth (req §12, §4.2): stumps left by chopping regrow to full forest
// at the start of spring. Tiles now occupied by a building or field are skipped
// so a player's structures/crops are never overgrown. A missing forestWood entry
// means "full", so deleting it restores the tile to FOREST_WOOD_MAX wood.
function regrowForest(ctx: SimCtx): void {
  const W = ctx.map.width;
  const tiles = ctx.map.tiles;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] !== "stump") continue;
    const x = i % W;
    const y = Math.floor(i / W);
    if (buildingAt(ctx.buildings, x, y) || fieldAt(ctx.fields, x, y)) continue;
    tiles[i] = "forest";
    delete ctx.map.forestWood[i];
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
    const spd = moveSpeed(unit);
    const r = stepPath(x, y, path, node, timeLeft * spd.tilesPerTick);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * spd.ticksPerTile;
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
            ctx.map.mineType[idx] = rollMineType(ctx, idx);
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
    const spd = moveSpeed(unit);
    const r = stepPath(x, y, path, node, timeLeft * spd.tilesPerTick);
    x = r.x;
    y = r.y;
    node = r.node;
    timeLeft -= r.used * spd.ticksPerTile;
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

// --- Attack: close on an enemy, then hold (req §6.5, §17) ---
// Movement only — the once-per-second hits are applied by the combat pass
// (stepCombat) so all fighting shares one resolver. When adjacent, the unit
// stops; when the target dies or can't be reached, the order ends.

function advanceAttack(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "attack") return unit;
  const enemy = ctx.enemies[o.targetId];
  if (!enemy) return { ...unit, order: { type: "idle" } }; // target gone

  // Adjacent: hold position (combat pass swings). Clear any leftover path.
  if (hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, enemy) <= 1) {
    return { ...unit, order: { type: "attack", targetId: o.targetId, path: [], node: 0 } };
  }

  // Need to close in. Re-path to a walkable hex adjacent to the enemy when our
  // current path is spent (also covers the enemy having moved — M6).
  let path = o.path;
  let node = o.node;
  if (node >= path.length) {
    const np = pathAdjacentTo(ctx.map, unit, enemy.x, enemy.y, ctx.buildings);
    if (!np || np.length === 0) return { ...unit, order: { type: "idle" } };
    path = np;
    node = 0;
  }
  const r = stepPath(unit.x, unit.y, path, node, moveSpeed(unit).tilesPerTick * dtTicks);
  return { ...unit, x: r.x, y: r.y, order: { type: "attack", targetId: o.targetId, path, node: r.node } };
}

// --- Trade: travel to town, then exchange goods at listed values (req §18) ---

function advanceTrade(unit: Unit, dtTicks: number): Unit {
  const o = unit.order;
  if (o.type !== "trade") return unit;

  let x = unit.x;
  let y = unit.y;
  let { phase, node } = o;
  const { tx, ty, sell, buy, buyHorse, path } = o;

  if (phase === "toTown") {
    const spd = moveSpeed(unit);
    const r = stepPath(x, y, path, node, dtTicks * spd.tilesPerTick);
    x = r.x;
    y = r.y;
    node = r.node;
    if (node >= path.length) phase = "trading";
  }

  if (phase === "trading") {
    return resolveTrade({ ...unit, x, y }, sell, buy, buyHorse);
  }

  return { ...unit, x, y, order: { type: "trade", tx, ty, sell, buy, buyHorse, phase, path, node } };
}

// Resolve a town transaction against the unit's carried inventory (req §18, §8).
// Selling converts carried resources to value; buying (and a horse) spends it.
// The trade is rejected (unit just goes idle) if proceeds can't cover the cost.
// Any surplus value is returned as gold (whole coins) plus hay for the <10
// remainder, so total value is conserved exactly and stays integer.
function resolveTrade(
  unit: Unit,
  sell: Inventory,
  buy: Inventory,
  buyHorse: boolean,
): Unit {
  const carrying: Record<string, number> = { ...unit.carrying };

  // Proceeds from selling, clamped to what is actually carried.
  let credit = 0;
  for (const t of RESOURCE_TYPES) {
    const want = sell[t] ?? 0;
    if (want <= 0) continue;
    const amt = Math.min(carrying[t] ?? 0, want);
    carrying[t] = (carrying[t] ?? 0) - amt;
    credit += amt * RESOURCE_VALUE[t];
  }

  const wantHorse = buyHorse && !hasHorse(unit);
  const cost = inventoryValue(buy) + (wantHorse ? HORSE_COST_VALUE : 0);
  if (credit < cost) {
    // Can't afford: abandon the trade. `carrying` above was a local copy, so the
    // unit keeps its original inventory untouched.
    return { ...unit, order: { type: "idle" } };
  }

  // Apply purchases.
  for (const t of RESOURCE_TYPES) {
    const amt = buy[t] ?? 0;
    if (amt > 0) carrying[t] = (carrying[t] ?? 0) + amt;
  }
  const horseHp = wantHorse ? HORSE_BONUS_HP : unit.horseHp;

  // Return surplus value as gold + hay (value-exact change).
  const change = credit - cost;
  const goldChange = Math.floor(change / RESOURCE_VALUE.gold);
  const hayChange = change - goldChange * RESOURCE_VALUE.gold; // each hay = 1 value
  if (goldChange > 0) carrying.gold = (carrying.gold ?? 0) + goldChange;
  if (hayChange > 0) carrying.hay = (carrying.hay ?? 0) + hayChange;

  return { ...unit, carrying, horseHp, order: { type: "idle" } };
}

// --- Interactive town interface (req §18) ---
// A unit standing at (or next to) the town tile opens the marketplace UI, which
// drives these helpers via `townStore` / `townTrade` commands. Unlike the
// automatic `trade` order above, these resolve instantly against a unit already
// at town — no travel, no `order` change.

// Is the unit on the town tile to use the marketplace?
export function isUnitAtTown(unit: Unit, town: TileCoord): boolean {
  return hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, town) === 0;
}

// Move `amount` of one resource between the unit's inventory and town storage
// (req §18). Free — no value exchanged. Clamps to what is actually available and,
// when loading the unit, to its remaining carry capacity. Returns the updated
// unit; `ctx.townStorage` is mutated in place. A no-op if the unit isn't at town.
export function executeTownStore(
  ctx: SimCtx,
  unit: Unit,
  resource: ResourceType,
  amount: number,
  toStorage: boolean,
): Unit {
  if (amount <= 0) return unit;
  if (!isUnitAtTown(unit, ctx.town)) return unit;
  const carrying: Record<string, number> = { ...unit.carrying };
  if (toStorage) {
    const move = Math.min(amount, carrying[resource] ?? 0);
    if (move <= 0) return unit;
    carrying[resource] = (carrying[resource] ?? 0) - move;
    ctx.townStorage[resource] += move;
    return { ...unit, carrying };
  }
  // Town → unit, bounded by both town stock and free carry slots.
  const room = Math.max(0, carryCap(unit) - carriedTotal(unit.carrying));
  const move = Math.min(amount, ctx.townStorage[resource], room);
  if (move <= 0) return unit;
  ctx.townStorage[resource] -= move;
  carrying[resource] = (carrying[resource] ?? 0) + move;
  return { ...unit, carrying };
}

// Outcome of weighing a proposed town trade (req §18). Shared by the command
// handler (authoritative) and the UI (to enable/explain the Confirm button).
export interface TownTradeEval {
  ok: boolean;
  reason: string; // human-readable; "" when ok
  cartValue: number; // value of goods + horse requested
  offerValue: number; // value of goods offered (clamped to what's available)
  wantHorse: boolean; // a horse is actually being bought (not already mounted)
  change: { gold: number; hay: number }; // surplus returned to town storage
}

// Weigh a proposed trade without mutating anything (req §18). The shopkeeper
// accepts when the offered value meets or beats the cart value; surplus is
// returned to town storage as value-exact gold + hay change. Also rejects an
// empty cart, an offer the unit/town can't back, and a cart that won't fit in
// the unit's carry capacity once the offered-away goods leave.
export function evaluateTownTrade(
  unit: Unit,
  townStorage: ResourcePool,
  cart: Inventory,
  buyHorse: boolean,
  offerUnit: Inventory,
  offerStorage: Inventory,
): TownTradeEval {
  const wantHorse = buyHorse && !hasHorse(unit);
  let cartCount = 0;
  for (const t of RESOURCE_TYPES) cartCount += cart[t] ?? 0;
  const cartValue = inventoryValue(cart) + (wantHorse ? HORSE_COST_VALUE : 0);

  const base: TownTradeEval = {
    ok: false,
    reason: "",
    cartValue,
    offerValue: inventoryValue(offerUnit) + inventoryValue(offerStorage),
    wantHorse,
    change: { gold: 0, hay: 0 },
  };

  if (cartCount === 0 && !wantHorse) {
    return { ...base, reason: "Cart is empty" };
  }
  // Offer must be backed by goods actually on hand.
  for (const t of RESOURCE_TYPES) {
    if ((offerUnit[t] ?? 0) > (unit.carrying[t] ?? 0)) {
      return { ...base, reason: "Not enough carried goods to offer" };
    }
    if ((offerStorage[t] ?? 0) > townStorage[t]) {
      return { ...base, reason: "Not enough stored goods to offer" };
    }
  }
  if (base.offerValue < cartValue) {
    return { ...base, reason: "Shopkeeper rejects: offer worth too little" };
  }
  // Carry-cap check: bought resources land in the unit's inventory, while the
  // goods offered from the unit free up slots. A new horse adds capacity.
  let offeredFromUnit = 0;
  for (const t of RESOURCE_TYPES) offeredFromUnit += offerUnit[t] ?? 0;
  const projectedCap = carryCap({
    ...unit,
    horseHp: wantHorse ? HORSE_BONUS_HP : unit.horseHp,
  });
  const projectedLoad = carriedTotal(unit.carrying) - offeredFromUnit + cartCount;
  if (projectedLoad > projectedCap) {
    return { ...base, reason: "Purchase exceeds carry capacity" };
  }

  const surplus = base.offerValue - cartValue;
  const gold = Math.floor(surplus / RESOURCE_VALUE.gold);
  const hay = surplus - gold * RESOURCE_VALUE.gold; // each hay = 1 value
  return { ...base, ok: true, change: { gold, hay } };
}

// Apply a town trade (req §18) if the shopkeeper accepts it. Mutates
// `ctx.townStorage` and returns the updated unit; returns null (and changes
// nothing) on rejection or when the unit isn't at town.
export function executeTownTrade(
  ctx: SimCtx,
  unit: Unit,
  cart: Inventory,
  buyHorse: boolean,
  offerUnit: Inventory,
  offerStorage: Inventory,
): Unit | null {
  if (!isUnitAtTown(unit, ctx.town)) return null;
  const ev = evaluateTownTrade(unit, ctx.townStorage, cart, buyHorse, offerUnit, offerStorage);
  if (!ev.ok) return null;

  const carrying: Record<string, number> = { ...unit.carrying };
  // Take the offered goods out of the unit and out of town storage.
  for (const t of RESOURCE_TYPES) {
    const fromUnit = offerUnit[t] ?? 0;
    if (fromUnit > 0) carrying[t] = (carrying[t] ?? 0) - fromUnit;
    const fromStore = offerStorage[t] ?? 0;
    if (fromStore > 0) ctx.townStorage[t] -= fromStore;
  }
  // Hand over the purchased goods (into the unit's inventory).
  for (const t of RESOURCE_TYPES) {
    const amt = cart[t] ?? 0;
    if (amt > 0) carrying[t] = (carrying[t] ?? 0) + amt;
  }
  const horseHp = ev.wantHorse ? HORSE_BONUS_HP : unit.horseHp;
  // Return change to town storage so it's value-exact and never overflows carry.
  if (ev.change.gold > 0) ctx.townStorage.gold += ev.change.gold;
  if (ev.change.hay > 0) ctx.townStorage.hay += ev.change.hay;

  return { ...unit, carrying, horseHp };
}

// --- Hall / storage loading interface (T9) ---
// A worker on or beside a built storage building (Main Hall, Barn, …) opens a
// load/unload panel. Unlike the town interface — which uses the separate
// `townStorage` pool — these transfers move goods between the unit's inventory
// and the hamlet's shared `resources` pool, so they respect the storage cap.

// Is the unit standing on, or directly next to, this building's tile?
export function isUnitAtBuilding(unit: Unit, b: Building): boolean {
  return hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, b) <= 1;
}

// Move `amount` of one resource between the unit's inventory and the hamlet pool
// via `building` (T9). `toStorage` true = unit → pool, clamped to the pool's free
// space (capacity − current total); false = pool → unit, clamped to the unit's
// remaining carry slots. Always clamped to what's actually on hand. Returns the
// updated unit; `ctx.resources` is mutated in place. A no-op unless `building` is
// a built storage building and the unit is on or beside it.
export function executeHallStore(
  ctx: SimCtx,
  unit: Unit,
  building: Building,
  resource: ResourceType,
  amount: number,
  toStorage: boolean,
): Unit {
  if (amount <= 0) return unit;
  if (!isStorage(building) || !isUnitAtBuilding(unit, building)) return unit;
  const carrying: Record<string, number> = { ...unit.carrying };
  if (toStorage) {
    const space = Math.max(0, ctx.capacity - poolTotal(ctx.resources));
    const move = Math.min(amount, carrying[resource] ?? 0, space);
    if (move <= 0) return unit;
    carrying[resource] = (carrying[resource] ?? 0) - move;
    ctx.resources[resource] += move;
    return { ...unit, carrying };
  }
  // Pool → unit, bounded by both the pool stock and free carry slots.
  const room = Math.max(0, carryCap(unit) - carriedTotal(unit.carrying));
  const move = Math.min(amount, ctx.resources[resource], room);
  if (move <= 0) return unit;
  ctx.resources[resource] -= move;
  carrying[resource] = (carrying[resource] ?? 0) + move;
  return { ...unit, carrying };
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
    // Main Hall worker production has no occupant — handle it before the
    // occupant gate the smithy/barracks rely on (T5).
    if (b.kind === "mainHall") {
      if (b.spawning) tickMainHall(ctx, id, dtTicks, units);
      continue;
    }
    if (b.occupantId === null) continue;
    const op = units[b.occupantId];
    if (!op || op.insideBuildingId !== id) continue;

    if (b.kind === "smithy") tickSmithy(ctx, id, dtTicks, op);
    else if (b.kind === "barracks") tickBarracks(ctx, id, dtTicks, units);
  }
}

// Raise a worker at the Main Hall (T5). Accumulates ticks until
// WORKER_SPAWN_TICKS, then spawns a worker on a free tile next to the hall.
// Mirrors the smithy's "stall at cap" pattern: if every House slot filled up
// mid-production (§7.4), progress holds at the cap until a slot frees.
function tickMainHall(
  ctx: SimCtx,
  id: number,
  dtTicks: number,
  units: Record<number, Unit>,
): void {
  const b = ctx.buildings[id];
  const newProgress = b.spawnProgress + dtTicks;
  if (newProgress < WORKER_SPAWN_TICKS) {
    ctx.buildings[id] = { ...b, spawnProgress: newProgress };
    return;
  }
  if (unitCount(units, "worker") >= workerHousingCap(ctx.buildings)) {
    ctx.buildings[id] = { ...b, spawnProgress: WORKER_SPAWN_TICKS };
    return;
  }
  const spot = freeAdjacentTile(ctx.map, b.x, b.y, ctx.buildings) ?? { x: b.x, y: b.y };
  const wid = ctx.nextId++;
  units[wid] = makeWorker(wid, spot.x, spot.y);
  ctx.buildings[id] = { ...b, spawning: false, spawnProgress: 0 };
}

// Nearest walkable neighbour of (x,y) for placing a freshly produced unit, so it
// doesn't sit on the building tile. Falls back to null if the hall is boxed in.
function freeAdjacentTile(
  map: GameMap,
  x: number,
  y: number,
  buildings: Record<number, Building>,
): TileCoord | null {
  for (const n of hexNeighbors(x, y)) {
    if (isWalkable(map, n.x, n.y, buildings)) return n;
  }
  return null;
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
    if (b.kind === "house") cap += HOUSE_HOUSING_CAPACITY;
  }
  return cap;
}

export function barracksHousingCap(buildings: Record<number, Building>): number {
  let cap = 0;
  for (const b of Object.values(buildings)) {
    if (!isBuilt(b)) continue;
    if (b.kind === "barracks") cap += BARRACKS_HOUSING_CAPACITY;
  }
  return cap;
}

export function unitCount(units: Record<number, Unit>, kind: UnitKind): number {
  let n = 0;
  for (const u of Object.values(units)) if (u.kind === kind) n++;
  return n;
}
