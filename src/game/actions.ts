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
  HORSE_BONUS_HP,
  HORSE_COST_VALUE,
  HORSE_SPEED_MULT,
  HOUSE_HOUSING_CAPACITY,
  MINE_TYPE_WEIGHTS_BY_MOUNTAIN,
  ORE_TICKS_PER_UNIT,
  PLANT_TICKS,
  PLANT_WHEAT_COST,
  PLOUGH_TICKS,
  SEASONS,
  STABLES_BUILD_TICKS,
  STABLES_COST,
  STABLES_HORSE_CAPACITY,
  TICKS_PER_SECOND,
  TRAIN_TICKS,
  HEAL_PERCENT_PER_INTERVAL,
  HEAL_INTERVAL_TICKS,
  SEASON_HEAL_PERCENT,
  UNIT_MAX_HP,
  UPKEEP,
  WHEAT_HARVEST_MAX,
  WHEAT_HARVEST_MIN,
  WOOD_ROAM_RADIUS,
  WOOD_TICKS_PER_UNIT,
  WORKER_SPAWN_TICKS,
  MINE_GOBLIN_SPAWN_CHANCE,
  SERPENT_SPAWN_CHANCE,
  KRAKEN_SPAWN_CHANCE,
  TICKS_PER_SEASON,
  TICKS_PER_YEAR,
  ATTACK_MIN_GOBLIN_YEARS,
  RAID_WORKERS_PER_GOBLIN,
  RAID_CHIEF_SWORD_THRESHOLD,
  WARBAND_BUILDINGS_PER_GOBLIN,
  WARBAND_SPIDERS_PER_MILITARY,
  WARBAND_CHIEF_MINE_THRESHOLD,
  PLUNDER_VALUE_PER_GOBLIN,
  PLUNDER_GOLD_PER_CHIEF,
  DRAGON_DIAMOND_THRESHOLD,
  GOBLIN_ATTACK_GOLD_THRESHOLD,
  GOBLIN_ATTACK_GOLD_PER_GOBLIN,
  TAX_FLAVOUR_COEFFS,
  TAX_MAX_GOLD_PER_YEAR,
  TAX_RESOURCE_FRACTION,
  TAX_DIAMOND_MULT,
  TAX_BUILDING_FRACTION,
  FESTIVAL_GATHER_MULT,
  FESTIVAL_WORK_MULT,
  HARSH_WINTER_UPKEEP_MULT,
  STORAGE_THIEF_FRACTION,
  PLAGUE_HP_FRACTION,
  BOUNTIFUL_HARVEST_FRACTION,
  CROP_BLIGHT_FRACTION,
  BLIGHT_FRACTION,
  WOOD_BOON_FRACTION,
  BARN_FIRE_FRACTION,
  TERMITES_MEAT_PER_WOOD,
  TERMITES_WOOD_LOSS_FRACTION,
  MIDAS_GOLD_PER_MEAT,
  MIDAS_MEAT_LOSS_FRACTION,
  LOST_CARAVAN_MIN,
  LOST_CARAVAN_MAX,
  FOREST_WOOD_MIN,
  FOREST_WOOD_MAX,
  type BuildCost,
} from "../config/index.js";
import { fieldActionInSeason, seasonAt, seasonBoundaries } from "./season.js";
import {
  buildingAt,
  isBuilt,
  isStorage,
  makeBuilding,
  nearestStorage,
  type Building,
  type BuildingKind,
  type CraftItem,
  type TrainTarget,
} from "./buildings.js";
import { isWaterEnemy, makeEnemy, type DamageEvent, type Enemy, type EnemyKind, type HealEvent } from "./combat.js";
import {
  attackFlavourLabel,
  chooseUpcomingEvent,
  MISC_TRADE_OFFERS,
  TAX_FLAVOURS,
  type ActiveEvent,
  type AttackFlavour,
  type EventCategory,
  type MiscEventKind,
  type MiscTradeKind,
  type MiscTradeState,
  type TaxFlavour,
  type UpcomingEvent,
} from "./events.js";
import type { BuildableKind } from "./commands.js";
import { fieldAt, makeField, type Field } from "./fields.js";
import { makeHorse, type Horse } from "./horses.js";
import { hexDistance, hexNeighbors } from "./hex.js";
import {
  forestRemaining,
  inBounds,
  isTownTile,
  isWalkable,
  isWaterAdjacent,
  mountainTypeAt,
  tileAt,
  type GameMap,
  type MineType,
  type TileCoord,
} from "./map.js";
import { findPath } from "./pathfinding.js";
import { rngInt, rngNext } from "./rng.js";
import {
  carriedTotal,
  inventoryValue,
  makeChange,
  poolTotal,
  RESOURCE_TYPES,
  RESOURCE_VALUE,
  type Inventory,
  type ResourcePool,
  type ResourceType,
} from "./resources.js";
import type {
  EquipmentPool,
  EventModifiers,
  GameNotification,
  GamePhase,
  GroundItem,
  NotificationKind,
  RunStats,
} from "./state.js";
import {
  canCarryResource,
  carryCap,
  hasHorse,
  makeUnit,
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
  groundItems: Record<number, GroundItem>; // loose loot on the ground (req §6.2)
  horses: Record<number, Horse>; // riderless horses (req §9); copied each step
  equipment: EquipmentPool;
  town: TileCoord;
  townStorage: ResourcePool; // goods stored at town (req §18); outside the cap
  rngState: number;
  tickCount: number; // tick count *after* this step (for field timing)
  nextId: number; // entity-id allocator; read back after the step
  notifications: GameNotification[]; // player-facing event log; appended in place
  damageEvents: DamageEvent[]; // combat damage toasts this step; appended in place
  healEvents: HealEvent[]; // heal toasts this step (req §6.2); appended in place
  // End-of-year event state (req §16, §21.1). Mutated by the event systems
  // below; update() reads these back into the next GameState.
  phase: GamePhase;
  upcomingEvent: UpcomingEvent;
  activeEvent: ActiveEvent | null;
  eventSchedule: EventCategory[];
  eventMods: EventModifiers;
  stats: RunStats;
}

// Append a player-facing event to the log. Id comes from the shared entity
// counter so the UI can dedup; the caller bounds the list when writing back.
function notify(
  ctx: SimCtx,
  kind: NotificationKind,
  message: string,
  loc?: TileCoord,
): void {
  ctx.notifications.push({
    id: ctx.nextId++,
    tick: ctx.tickCount,
    kind,
    message,
    ...(loc ? { x: loc.x, y: loc.y } : {}),
  });
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
    // Mining requires a built Mine on the mountain tile (req §13).
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
  // Mining + fishing are open to workers and soldiers; captains don't gather
  // (they carry only gold/diamonds, §6.1).
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
  // A moving goblin sits at a fractional position mid-march; adjacency and
  // pathing work in whole hexes, so aim at the goblin's current tile.
  const ex = Math.round(enemy.x);
  const ey = Math.round(enemy.y);
  // Already adjacent? Hold position and let the combat pass do the hitting.
  if (hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, { x: ex, y: ey }) <= 1) {
    return { type: "attack", targetId, path: [], node: 0 };
  }
  const path = pathAdjacentTo(ctx.map, unit, ex, ey, ctx.buildings);
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
  // Captains carry only gold/diamonds (§6.1) but may still ride to town for a horse.
  const path = pathFromUnit(map, unit, town, buildings);
  if (!path) return { type: "idle" };
  return { type: "trade", tx: town.x, ty: town.y, sell, buy, buyHorse, phase: "toTown", path, node: 0 };
}

// --- Placement & costing (req §7.1, §7) ---

export function buildableCost(kind: BuildableKind): BuildCost {
  return kind === "stables" ? STABLES_COST : BUILDING_COST[kind as BuildingKind];
}

export function placementValid(
  map: GameMap,
  buildings: Record<number, Building>,
  fields: Record<number, Field>,
  kind: BuildableKind,
  x: number,
  y: number,
  town: TileCoord,
): boolean {
  if (!inBounds(map, x, y)) return false;
  if (buildingAt(buildings, x, y)) return false;
  if (fieldAt(fields, x, y)) return false;
  // The town flower (market + its six tiles) is reserved (req §18).
  if (isTownTile(town, x, y)) return false;
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
// (§13.1). idx is the tile index so we can read its MountainType.
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

// Ticks per yield for a gather, after the active year-long event modifiers
// (§16.3): a Festival speeds gathering by FESTIVAL_GATHER_MULT, and a Mild
// Winter waives winter's fishing penalty (treats it like the base season).
function gatherInterval(ctx: SimCtx, resource: GatherResource): number {
  let interval: number;
  if (resource === "fish") {
    const season = seasonAt(ctx.tickCount);
    interval =
      season === "Winter" && ctx.eventMods.mildWinter
        ? FISH_TICKS_PER_UNIT // mild winter: no winter fishing penalty (§16.3)
        : FISH_TICKS_BY_SEASON[season];
  } else {
    interval = GATHER_INTERVAL[resource];
  }
  if (ctx.eventMods.festival) interval /= FESTIVAL_GATHER_MULT;
  return interval;
}

// Multiplier on build/craft/train/spawn *durations* (§16.3): a Festival shaves
// FESTIVAL_WORK_MULT off the time, so totals shrink while it is active.
function festivalWorkMult(ctx: SimCtx): number {
  return ctx.eventMods.festival ? FESTIVAL_WORK_MULT : 1;
}

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
// `workerId` is the gatherer, so a mine goblin can focus the miner (req §13.2).
function produceYield(
  ctx: SimCtx,
  resource: GatherResource,
  wx: number,
  wy: number,
  carrying: Record<string, number>,
  workerId: number,
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
    maybeSpawnFishingEnemy(ctx, wx, wy, workerId); // §17.3: serpent/kraken attack
  } else {
    const idx = wy * W + wx;
    const res = oreYield(ctx, idx);
    carrying[res] = (carrying[res] ?? 0) + 1;
    maybeSpawnMineGoblin(ctx, wx, wy, workerId); // §13.2: goblin(s) at iron/gold mine
    if (res === "diamond") {
      // §13.2: a diamond always triggers a 2-goblin attack, on top of the
      // ordinary 15% roll above.
      const spot = spawnMineGoblins(ctx, wx, wy, workerId, 2);
      if (spot) notify(ctx, "enemy", "A diamond drew goblins to a mine! Click to view.", spot);
    }
  }
}

// --- Enemy spawning (req §13.2, §17.3) ---

// Iron and gold mines attract goblins: per mining yield there is a fixed chance
// (req §13.2) goblins spawn next to the mine and focus the miner — an iron mine
// draws 1 goblin, a gold mine draws 2. Stone mines are left alone. A no-op when
// there's no walkable hex by the mine to land on.
function maybeSpawnMineGoblin(ctx: SimCtx, wx: number, wy: number, minerId: number): void {
  if (ctx.phase === "endOfYearEvent") return; // no ambient spawns during a year-end event
  const type = ctx.map.mineType[wy * ctx.map.width + wx];
  if (type !== "iron" && type !== "gold") return;
  const [s, v] = rngNext(ctx.rngState);
  ctx.rngState = s;
  if (v >= MINE_GOBLIN_SPAWN_CHANCE) return;
  const count = type === "gold" ? 2 : 1; // §13.2: gold mines draw 2 goblins, iron 1
  const spot = spawnMineGoblins(ctx, wx, wy, minerId, count);
  if (!spot) return;
  // warn the player and let them jump to the fight (the loop pauses on this).
  const what = count > 1 ? "Goblins" : "A goblin";
  notify(ctx, "enemy", `${what} attacked a mine! Click to view.`, spot);
}

// Spawn up to `count` goblins on distinct walkable hexes next to the mine (the
// miner stands on the mine tile, so neighbours put them adjacent), each focusing
// the miner. Returns the first goblin's tile (for the notification), or null when
// the mine is boxed in with no room. Fewer than `count` spawn if neighbours run out.
function spawnMineGoblins(
  ctx: SimCtx,
  x: number,
  y: number,
  minerId: number,
  count: number,
): TileCoord | null {
  let first: TileCoord | null = null;
  let spawned = 0;
  for (const n of hexNeighbors(x, y)) {
    if (spawned >= count) break;
    if (!isWalkable(ctx.map, n.x, n.y, ctx.buildings)) continue;
    const id = ctx.nextId++;
    ctx.enemies[id] = makeEnemy(id, "goblin", n.x, n.y, minerId, ctx.tickCount);
    if (!first) first = n;
    spawned++;
  }
  return first; // null ⇒ mine boxed in (a built mine always has ≥1 walkable neighbour)
}

// Fishing draws predators (req §14): per fish yield two independent rolls fire — a
// 15% sea serpent and a separate 7% kraken. When both hit, the kraken (the worse
// of the two) is the one that surfaces. The predator appears on a water tile
// beside the fisher and focuses them. Skipped if a water predator is already next
// to this spot, so they don't stack on a single fishing hole.
function maybeSpawnFishingEnemy(ctx: SimCtx, wx: number, wy: number, fisherId: number): void {
  if (ctx.phase === "endOfYearEvent") return; // no ambient spawns during a year-end event
  const water = hexNeighbors(wx, wy).find((n) => tileAt(ctx.map, n.x, n.y) === "water");
  if (!water) return;
  for (const key of Object.keys(ctx.enemies)) {
    const e = ctx.enemies[Number(key)];
    if (isWaterEnemy(e.kind) && hexDistance({ x: Math.round(e.x), y: Math.round(e.y) }, { x: wx, y: wy }) <= 1) {
      return; // already under attack here
    }
  }
  // Two independent rolls (req §14); the kraken takes precedence when both fire.
  const [s, vSerpent] = rngNext(ctx.rngState);
  const [s2, vKraken] = rngNext(s);
  ctx.rngState = s2;
  let kind: EnemyKind | null = null;
  if (vKraken < KRAKEN_SPAWN_CHANCE) kind = "kraken";
  else if (vSerpent < SERPENT_SPAWN_CHANCE) kind = "seaSerpent";
  if (!kind) return;
  // Align the spawn tick to the start of the current season so the predator
  // despawns at the start of that same season one year later (req §17.3).
  const spawnTick = Math.floor(ctx.tickCount / TICKS_PER_SEASON) * TICKS_PER_SEASON;
  const id = ctx.nextId++;
  ctx.enemies[id] = makeEnemy(id, kind, water.x, water.y, fisherId, spawnTick);
  // warn the player and let them jump to the fight (the loop pauses on this).
  const what = kind === "kraken" ? "A kraken" : "A sea serpent";
  notify(ctx, "enemy", `${what} attacked a fisher! Click to view.`, water);
}

// --- Per-unit order advancement ---

// pick an automatic field order for an idle worker standing on a field tile,
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

export function advanceUnit(
  unit: Unit,
  dtTicks: number,
  ctx: SimCtx,
  units: Record<number, Unit>,
): Unit {
  return collectGroundItems(ctx, advanceUnitOrder(unit, dtTicks, ctx, units));
}

function advanceUnitOrder(
  unit: Unit,
  dtTicks: number,
  ctx: SimCtx,
  units: Record<number, Unit>,
): Unit {
  switch (unit.order.type) {
    case "idle": {
      // a worker left idle on a field tends it automatically — plant in
      // spring, harvest in fall — so staple farming needs no babysitting.
      const auto = autoFarmOrder(unit, ctx);
      return auto ? advanceUnitOrder({ ...unit, order: auto }, dtTicks, ctx, units) : unit;
    }
    case "move":
      return advanceMove(unit, dtTicks, ctx);
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
    case "mount":
      return advanceMount(unit, dtTicks, ctx);
    case "trade":
      return advanceTrade(unit, dtTicks, ctx, units);
  }
}

// Collect any loose loot (req §6.2) on the unit's current tile, up to its carry
// room. A unit hidden inside a building can't reach the ground; captains carry no
// resources (cap 0) so they pick up nothing. Consumed stacks are removed from the
// ground; a partially-collected stack keeps its remainder for the next passer-by.
function collectGroundItems(ctx: SimCtx, unit: Unit): Unit {
  if (unit.insideBuildingId !== null) return unit;
  const tx = Math.round(unit.x);
  const ty = Math.round(unit.y);
  let carrying = unit.carrying;
  let copied = false;
  for (const key of Object.keys(ctx.groundItems)) {
    const g = ctx.groundItems[Number(key)];
    if (g.x !== tx || g.y !== ty) continue;
    if (!canCarryResource(unit, g.resource)) continue; // captains take only gold/diamond (§6.1)
    const room = carryCap(unit) - carriedTotal(carrying);
    if (room <= 0) break;
    const taken = Math.min(room, g.qty);
    if (taken <= 0) continue;
    if (!copied) { carrying = { ...carrying }; copied = true; }
    carrying[g.resource] = (carrying[g.resource] ?? 0) + taken;
    if (taken >= g.qty) delete ctx.groundItems[g.id];
    else ctx.groundItems[g.id] = { ...g, qty: g.qty - taken };
  }
  return copied ? { ...unit, carrying } : unit;
}

// True when an enemy currently stands on tile (x, y).
function enemyOnTile(enemies: Record<number, Enemy>, x: number, y: number): boolean {
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    if (Math.round(e.x) === x && Math.round(e.y) === y) return true;
  }
  return false;
}

function advanceMove(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "move") return unit;
  const r = stepPath(unit.x, unit.y, o.path, o.node, moveSpeed(unit).tilesPerTick * dtTicks);
  // A unit never steps onto a tile an enemy occupies: if this step
  // would land on one, hold at the current tile (snapped to its centre, since
  // the unit may be mid-march) and drop the move order.
  if (enemyOnTile(ctx.enemies, Math.round(r.x), Math.round(r.y))) {
    return { ...unit, x: Math.round(unit.x), y: Math.round(unit.y), order: { type: "idle" } };
  }
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
      // Arrived: settle on the tile centre so the worker mines/chops/fishes (or
      // deposits) standing on a tile, never between two. An empty path (already
      // on the target tile) otherwise leaves it at a fractional mid-tile spot.
      x = Math.round(x);
      y = Math.round(y);
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
      // penalty. Wood/ore use their fixed intervals. Year-long event modifiers
      // (Festival / Mild Winter, §16.3) fold in here.
      const interval = gatherInterval(ctx, resource);
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
        produceYield(ctx, resource, wx, wy, carrying, unit.id);
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

  // Tend the field from the tile centre, not a fractional mid-tile spot — an
  // empty path (already on the tile) otherwise leaves the worker off-centre.
  if (phase === "working") {
    x = Math.round(x);
    y = Math.round(y);
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
    // The town flower is reserved (req §18) — never plough it into a field.
    if (isTownTile(ctx.town, tx, ty)) return;
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
    // harvest — a ripe field yields a random 10–20 wheat, clamped to space.
    if (field.stage === "grown") {
      const space = ctx.capacity - poolTotal(ctx.resources);
      ctx.resources.wheat += Math.min(rollWheatYield(ctx), Math.max(0, space));
      ctx.fields[field.id] = { ...field, stage: "ploughed" }; // replantable
    }
  }
}

// Random wheat yield for one harvested field, in [WHEAT_HARVEST_MIN, MAX].
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

// --- Healing (req §6.2) ---

// Restore up to `amount` HP to a unit, capped at its kind's max, and float a
// green "+N" toast for the amount actually healed. A no-op for an absent or
// already-full unit. Horse buffer HP does not regenerate — only the unit's own.
function healUnit(ctx: SimCtx, units: Record<number, Unit>, id: number, amount: number): void {
  const u = units[id];
  if (!u) return;
  const max = UNIT_MAX_HP[u.kind];
  const healed = Math.min(amount, max - u.hp);
  if (healed <= 0) return;
  units[id] = { ...u, hp: u.hp + healed };
  ctx.healEvents.push({ x: u.x, y: u.y, amount: healed });
}

// Idle HP regeneration (req §6.2): a wounded unit heals 5% of max HP every 5 sec
// while idle. The cadence is derived from the tick count (so no per-unit state is
// persisted): each HEAL_INTERVAL_TICKS boundary this step crosses heals every
// currently-idle wounded unit. "Idle" = order type `idle` (a unit mid-path is in
// a `move` order, and gather/build/etc. are their own order types, so all are
// excluded). Season time freezes during a year-end event, so no idle regen
// happens mid-attack.
export function applyIdleHealing(
  ctx: SimCtx,
  units: Record<number, Unit>,
  prevTick: number,
): void {
  const intervals =
    Math.floor(ctx.tickCount / HEAL_INTERVAL_TICKS) -
    Math.floor(prevTick / HEAL_INTERVAL_TICKS);
  if (intervals <= 0) return;
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.order.type !== "idle") continue;
    const perInterval = Math.ceil(UNIT_MAX_HP[u.kind] * HEAL_PERCENT_PER_INTERVAL);
    healUnit(ctx, units, u.id, perInterval * intervals);
  }
}

export function processSeasonTransitions(
  ctx: SimCtx,
  prevTick: number,
  units: Record<number, Unit>,
): void {
  for (const b of seasonBoundaries(prevTick, ctx.tickCount)) {
    // End of every season: charge upkeep with the §6.3 demotion ladder.
    chargeUpkeep(ctx, units);
    // Season change: every wounded unit gets an immediate +25% max-HP heal,
    // idle or not (req §6.2). Runs after upkeep so a just-demoted unit (reset to
    // full HP) is simply skipped.
    for (const key of Object.keys(units)) {
      const u = units[Number(key)];
      healUnit(ctx, units, u.id, Math.ceil(UNIT_MAX_HP[u.kind] * SEASON_HEAL_PERCENT));
    }
    // Every season change: water predators that have lived a full year leave at
    // the start of their spawn season (§17.3).
    despawnWaterEnemies(ctx);
    // End of fall: any wheat not harvested in time is lost (§11.5).
    if (SEASONS[b.endedIndex] === "Fall") {
      loseUnharvestedCrops(ctx);
    }
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

// Worker food (req §6.1/§6.2): each worker eats 1 wheat OR ½ meat — one meat feeds
// two workers, three workers consume two meat, and no fraction of meat is ever
// left over. Soldiers have already claimed their meat above, so workers split
// whatever remains. Meat is spent first (wheat doubles as planting seed, §11),
// then wheat, then any workers still unfed starve. `costPer` is the per-worker
// upkeep (doubled by a Harsh Winter, §16.3). Returns the ids that went unfed —
// the trailing workers in `workerIds`, deterministically.
function feedWorkers(ctx: SimCtx, workerIds: number[], costPer: number): number[] {
  // Total food owed, counted in single-food units (1 wheat or ½ meat each).
  let needed = workerIds.length * costPer;
  // Meat first: each meat covers two units of need (rounded up — no half-meat).
  const meatToSpend = Math.min(ctx.resources.meat, Math.ceil(needed / 2));
  ctx.resources.meat -= meatToSpend;
  needed = Math.max(0, needed - meatToSpend * 2);
  // Wheat next: one wheat per remaining unit of need.
  const wheatToSpend = Math.min(ctx.resources.wheat, needed);
  ctx.resources.wheat -= wheatToSpend;
  needed -= wheatToSpend;
  // Whatever need remains starves `needed / costPer` workers (the trailing ones).
  const starveCount = Math.ceil(needed / costPer);
  return workerIds.slice(workerIds.length - starveCount);
}

// End-of-season upkeep + demotion ladder (req §6.3). Captains and soldiers are
// charged before workers so they claim their gold/meat first and workers fall
// back to wheat; each unit is charged once, by the rank it held at season-end.
function chargeUpkeep(ctx: SimCtx, units: Record<number, Unit>): void {
  // Harsh Winter doubles this season's upkeep (§16.3); the flag is consumed once.
  const mult = ctx.eventMods.harshUpkeep ? HARSH_WINTER_UPKEEP_MULT : 1;
  if (ctx.eventMods.harshUpkeep) ctx.eventMods = { ...ctx.eventMods, harshUpkeep: false };

  const captains: number[] = [];
  const soldiers: number[] = [];
  const workers: number[] = [];
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.kind === "captain") captains.push(u.id);
    else if (u.kind === "soldier") soldiers.push(u.id);
    else workers.push(u.id);
  }

  // Captain: gold, else demote to soldier.
  for (const id of captains) {
    if (ctx.resources.gold >= UPKEEP.captain * mult) ctx.resources.gold -= UPKEEP.captain * mult;
    else demote(ctx, units, id, "soldier");
  }
  // Soldier: meat, else demote to worker.
  for (const id of soldiers) {
    if (ctx.resources.meat >= UPKEEP.soldier * mult) ctx.resources.meat -= UPKEEP.soldier * mult;
    else demote(ctx, units, id, "worker");
  }
  // Worker: food (meat or wheat), batched so one meat feeds two (§6.1/§6.2).
  // Unfed workers die (§6.3 — only workers are permanently lost; higher tiers
  // fall back one rank). A Mild Winter waives worker upkeep for the whole year
  // it is active (§16.3); the flag is cleared at the year boundary, not here.
  if (!ctx.eventMods.mildWinter) {
    for (const id of feedWorkers(ctx, workers, UPKEEP.worker * mult)) {
      const u = units[id];
      if (u) releaseOccupancy(ctx, u);
      delete units[id];
      notify(ctx, "death", "A worker starved and was lost — no food for upkeep.");
    }
  }
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

// Water predators persist one year from spawn (req §17.3): a predator leaves at
// the start of the same season the next year, i.e. once a full year of ticks has
// elapsed since its (season-aligned) spawn tick. Checked at every season
// boundary. Land goblins persist until killed.
function despawnWaterEnemies(ctx: SimCtx): void {
  for (const key of Object.keys(ctx.enemies)) {
    const e = ctx.enemies[Number(key)];
    if (isWaterEnemy(e.kind) && ctx.tickCount - e.spawnTick >= TICKS_PER_YEAR) {
      delete ctx.enemies[Number(key)];
    }
  }
}

// Forest regrowth (req §12, §4.2): stumps left by chopping regrow to full forest
// at the start of spring. Tiles now occupied by a building or field are skipped
// so a player's structures/crops are never overgrown. Each regrown tile rolls a
// fresh 1D6+2 wood reserve (req §12) from the seeded RNG.
function regrowForest(ctx: SimCtx): void {
  const W = ctx.map.width;
  const tiles = ctx.map.tiles;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] !== "stump") continue;
    const x = i % W;
    const y = Math.floor(i / W);
    if (buildingAt(ctx.buildings, x, y) || fieldAt(ctx.fields, x, y)) continue;
    tiles[i] = "forest";
    let w: number;
    [ctx.rngState, w] = rngInt(ctx.rngState, FOREST_WOOD_MIN, FOREST_WOOD_MAX);
    ctx.map.forestWood[i] = w;
  }
}

// --- End-of-year events (req §16, §21.1) ---
// One event fires per year at the winter→spring boundary. update() detects the
// boundary (in the `playing` phase) and calls triggerEvent, which rolls the
// magnitude of the announced event. The two event shapes differ sharply:
//   • Attack — fought *live* (§16.1): the wave spawns, a warning is posted, and
//     the year resolves immediately, so the phase stays `playing` and time and
//     production carry on into spring while the wave marches in.
//   • Tax / Misc — a *modal* (§16.2, §16.3): triggerEvent flips the phase to
//     `endOfYearEvent`, which update() treats as a full pause (no time, motion,
//     combat, or production) until the player closes the dialog and resolveEvent
//     returns control to `playing`.
// The loss check runs continuously, including mid-attack.

// The year that just ended at the current (boundary) tick — the scaling input
// for event magnitudes (§16.0). At the winter→spring boundary tickCount is a
// whole multiple of TICKS_PER_YEAR, so this is the completed-year count (≥1).
function eventYear(ctx: SimCtx): number {
  return Math.max(1, Math.floor(ctx.tickCount / TICKS_PER_YEAR));
}

// Fire the announced year-end event (§16.0). Clears the previous year's
// year-long modifiers, then rolls the event's magnitude. Attacks spawn their
// wave and resolve at once (no modal, no pause); tax/misc open the modal phase.
export function triggerEvent(ctx: SimCtx, units: Record<number, Unit>): void {
  // The prior year's Festival/Mild-Winter effects expire as the new year opens.
  ctx.eventMods = { ...ctx.eventMods, festival: false, mildWinter: false };
  const up = ctx.upcomingEvent;
  if (up.category === "attack") {
    // An attack does not freeze time (req §16.1): spawn the wave (with a warning
    // banner), then resolve the year straight away so the phase never leaves
    // `playing`. The calendar rolls into spring and production continues while
    // the wave marches in to be fought live.
    spawnAttackWave(ctx, units);
    resolveEvent(ctx);
    return;
  }
  // Tax and Misc are modal (req §16.2, §16.3): enter the endOfYearEvent phase so
  // update() pauses the world until the player settles/acknowledges the dialog.
  ctx.phase = "endOfYearEvent";
  if (up.category === "tax") {
    ctx.activeEvent = startTax(ctx, units);
  } else {
    const { summary, trade } = applyMiscEvent(ctx, units, up.misc);
    ctx.activeEvent = { category: "misc", misc: up.misc, summary, trade };
  }
}

// Return control to normal play (§21.1) and announce next year's event (§16.0).
export function resolveEvent(ctx: SimCtx): void {
  ctx.stats = { ...ctx.stats, yearsSurvived: ctx.stats.yearsSurvived + 1 };
  // The just-resolved event was this year's; announce the next year's along the
  // fixed cadence, threading the leftover block schedule back into state (§16.0).
  const [s, next, schedule] = chooseUpcomingEvent(
    ctx.rngState,
    eventYear(ctx) + 1,
    ctx.eventSchedule,
  );
  ctx.rngState = s;
  ctx.upcomingEvent = next;
  ctx.eventSchedule = schedule;
  ctx.activeEvent = null;
  ctx.phase = "playing";
}

// Loss conditions (req §21, §21.1): the Main Hall is destroyed, or no workers
// remain. Checked continuously (including mid-attack); flips the phase to
// gameOver. The render loop stops stepping the sim once it sees gameOver.
export function checkLoss(ctx: SimCtx, units: Record<number, Unit>): void {
  if (ctx.phase === "gameOver") return;
  let hasMainHall = false;
  for (const b of Object.values(ctx.buildings)) {
    if (b.kind === "mainHall") { hasMainHall = true; break; }
  }
  let workers = 0;
  for (const u of Object.values(units)) if (u.kind === "worker") workers++;
  if (!hasMainHall || workers === 0) ctx.phase = "gameOver";
}

// --- Attack event (§16.1) ---

// The minimum number of goblins in any wave (§16.1): a wave is never empty, and
// the floor grows by 1 every ATTACK_MIN_GOBLIN_YEARS years so late-game waves
// stay meaningful even when the keyed stat is small (e.g. a hoarder with no gold
// drawing a Goblin/Dragon attack).
function attackMinGoblins(year: number): number {
  return Math.max(1, Math.floor(year / ATTACK_MIN_GOBLIN_YEARS));
}

// Total swords the hamlet holds — both stored in the smithy pool and equipped on
// units (§16.1 Raiding party / §16.2 Weapon tax key off this).
function swordsHeld(ctx: SimCtx, units: Record<number, Unit>): number {
  let n = ctx.equipment.sword;
  for (const u of Object.values(units)) if (u.equipped.sword) n++;
  return n;
}

// Total shields the hamlet holds — pool + equipped (§16.2 Weapon tax).
function shieldsHeld(ctx: SimCtx, units: Record<number, Unit>): number {
  let n = ctx.equipment.shield;
  for (const u of Object.values(units)) if (u.equipped.shield) n++;
  return n;
}

// Count built/under-construction buildings of a given kind.
function buildingCount(ctx: SimCtx, kind: BuildingKind): number {
  let n = 0;
  for (const b of Object.values(ctx.buildings)) if (b.kind === kind) n++;
  return n;
}

// Roll the wave composition (count + type mix) for a flavour, keyed off the
// matching hamlet stat plus the year so later years are harder (§16.1). Returns
// a per-kind enemy count.
function attackComposition(
  ctx: SimCtx,
  units: Record<number, Unit>,
  flavour: AttackFlavour,
  year: number,
): Record<EnemyKind, number> {
  const comp: Record<EnemyKind, number> = {
    giantSpider: 0,
    goblin: 0,
    goblinChief: 0,
    seaSerpent: 0,
    kraken: 0,
    dragon: 0,
  };

  if (flavour === "raidingParty") {
    // Keys off worker count: 1 goblin per 2 workers, +1 chief if 2+ swords held.
    const workers = unitCount(units, "worker");
    comp.goblin = Math.floor(workers / RAID_WORKERS_PER_GOBLIN) + year;
    if (swordsHeld(ctx, units) >= RAID_CHIEF_SWORD_THRESHOLD) comp.goblinChief += 1;
  } else if (flavour === "warband") {
    // Keys off building count (houses/barns/smithy/barracks): goblins/2, +2
    // giant spiders per smithy or barracks, +1 chief if more than 4 mines.
    const buildings =
      buildingCount(ctx, "house") +
      buildingCount(ctx, "barn") +
      buildingCount(ctx, "smithy") +
      buildingCount(ctx, "barracks");
    comp.goblin = Math.floor(buildings / WARBAND_BUILDINGS_PER_GOBLIN) + year;
    const military = buildingCount(ctx, "smithy") + buildingCount(ctx, "barracks");
    comp.giantSpider = military * WARBAND_SPIDERS_PER_MILITARY;
    if (buildingCount(ctx, "mine") > WARBAND_CHIEF_MINE_THRESHOLD) comp.goblinChief += 1;
  } else if (flavour === "plunder") {
    // Keys off total stored resource value: goblins = value/20, +1 chief per 10
    // gold stored.
    const value = inventoryValue(ctx.resources);
    comp.goblin = Math.floor(value / PLUNDER_VALUE_PER_GOBLIN) + year;
    comp.goblinChief = Math.floor(ctx.resources.gold / PLUNDER_GOLD_PER_CHIEF);
  } else {
    // Goblin/Dragon — keys off gold/diamonds. 2+ diamonds → a single dragon;
    // else 10+ gold → a goblin chief + 1 goblin per 5 gold. With neither, the
    // min-goblin floor below keeps the wave non-empty.
    if (ctx.resources.diamond >= DRAGON_DIAMOND_THRESHOLD) {
      comp.dragon = 1;
    } else if (ctx.resources.gold >= GOBLIN_ATTACK_GOLD_THRESHOLD) {
      comp.goblinChief = 1;
      comp.goblin = Math.floor(ctx.resources.gold / GOBLIN_ATTACK_GOLD_PER_GOBLIN);
    }
  }

  // A wave is never empty (§16.1): unless a dragon is leading it, guarantee a
  // year-scaled goblin floor.
  if (comp.dragon === 0) comp.goblin = Math.max(attackMinGoblins(year), comp.goblin);
  return comp;
}

// Spawn the year-end attack wave at a random map edge (§16.1). Each enemy marches
// on the hamlet via the existing land-enemy AI (no focus — picks the nearest
// unit/building) and is fought live during normal play. Posts a clickable
// warning banner naming the wave's flavour and pointing at its landing site.
function spawnAttackWave(ctx: SimCtx, units: Record<number, Unit>): void {
  const year = eventYear(ctx);
  let fv: number;
  [ctx.rngState, fv] = rngInt(ctx.rngState, 0, 3);
  const flavour: AttackFlavour =
    fv === 0 ? "raidingParty" : fv === 1 ? "warband" : fv === 2 ? "plunder" : "goblinDragon";
  const comp = attackComposition(ctx, units, flavour, year);

  // Spawn the toughest enemies first so they get the nearest landing tiles.
  const order: EnemyKind[] = ["dragon", "goblinChief", "giantSpider", "goblin"];
  const kinds: EnemyKind[] = [];
  for (const kind of order) for (let i = 0; i < comp[kind]; i++) kinds.push(kind);

  const origin = pickAttackOrigin(ctx);
  const tiles = findSpawnTiles(ctx, origin, kinds.length);

  for (let i = 0; i < tiles.length && i < kinds.length; i++) {
    const id = ctx.nextId++;
    ctx.enemies[id] = makeEnemy(id, kinds[i], tiles[i].x, tiles[i].y, null, ctx.tickCount);
  }
  // Warn the player and let them jump to the landing site (§16.1, §16.4).
  const label = attackFlavourLabel(flavour, comp.dragon > 0);
  notify(ctx, "enemy", `${label} attacks the hamlet! Click to view.`, tiles[0] ?? origin);
}

// A tile on a random map edge to spawn the wave from (§16.1). The actual landing
// tiles are the nearest walkable ones (findSpawnTiles), so a watery edge is fine.
function pickAttackOrigin(ctx: SimCtx): TileCoord {
  const W = ctx.map.width;
  const H = ctx.map.height;
  let side: number;
  [ctx.rngState, side] = rngInt(ctx.rngState, 0, 3);
  let pos: number;
  if (side === 0 || side === 1) {
    [ctx.rngState, pos] = rngInt(ctx.rngState, 0, W - 1);
    return { x: pos, y: side === 0 ? 0 : H - 1 };
  }
  [ctx.rngState, pos] = rngInt(ctx.rngState, 0, H - 1);
  return { x: side === 2 ? 0 : W - 1, y: pos };
}

// Up to `count` distinct walkable land tiles nearest `origin`, spiralling out in
// Chebyshev rings (mirrors placeTown's scan). Used to land an attack wave.
function findSpawnTiles(ctx: SimCtx, origin: TileCoord, count: number): TileCoord[] {
  const out: TileCoord[] = [];
  const used = new Set<number>();
  const W = ctx.map.width;
  for (let radius = 0; radius < W + ctx.map.height && out.length < count; radius++) {
    for (let dy = -radius; dy <= radius && out.length < count; dy++) {
      for (let dx = -radius; dx <= radius && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (!inBounds(ctx.map, x, y)) continue;
        if (!isWalkable(ctx.map, x, y, ctx.buildings)) continue;
        const idx = y * W + x;
        if (used.has(idx)) continue;
        used.add(idx);
        out.push({ x, y });
      }
    }
  }
  return out;
}

// --- Tax event (§16.2) ---

// Gold a single unit of resource `t` covers toward a tax demand (§16.2.1). The
// demand is in gold, so every rate is normalised against gold's trade value:
// gold pays face value (1), diamonds carry a 100% bonus, and every other
// resource pays TAX_RESOURCE_FRACTION of its value. The result is fractional
// (e.g. wheat → 0.1); contributions are summed and shown as decimals.
export function resourceTaxRate(t: ResourceType): number {
  if (t === "gold") return 1;
  if (t === "diamond") return (RESOURCE_VALUE.diamond * TAX_DIAMOND_MULT) / RESOURCE_VALUE.gold;
  return (RESOURCE_VALUE[t] * TAX_RESOURCE_FRACTION) / RESOURCE_VALUE.gold;
}

// Total gold an offered inventory covers toward a tax demand (§16.2.1). Trade
// value is summed first and normalised against gold once, so exact-multiple
// offers (20 wood → 3, etc.) land precisely instead of drifting below via
// per-unit fractions. May be fractional; no change is given for any overpayment.
export function resourceTaxGold(inv: Inventory): number {
  let value = 0;
  for (const t of RESOURCE_TYPES) {
    const n = inv[t] ?? 0;
    if (n <= 0) continue;
    if (t === "gold") value += n * RESOURCE_VALUE.gold;
    else if (t === "diamond") value += n * RESOURCE_VALUE.diamond * TAX_DIAMOND_MULT;
    else value += n * RESOURCE_VALUE[t] * TAX_RESOURCE_FRACTION;
  }
  return value / RESOURCE_VALUE.gold;
}

// Gold a surrendered building covers toward a tax demand (§16.2.1): a fraction of
// its build-cost value, priced the same way non-gold goods are. May be fractional.
function buildingCostValue(kind: BuildingKind): number {
  return inventoryValue(BUILDING_COST[kind]);
}
export function buildingTaxValue(kind: BuildingKind): number {
  return (buildingCostValue(kind) * TAX_BUILDING_FRACTION) / RESOURCE_VALUE.gold;
}

// The gold demand for a tax flavour (§16.2), keyed off the matching hamlet stat
// plus the year. Coefficients are tunable in TAX_FLAVOUR_COEFFS; this applies
// the matching formula. floor() divisions match the spec (e.g. gold/5).
function taxDemand(
  ctx: SimCtx,
  units: Record<number, Unit>,
  flavour: TaxFlavour,
  year: number,
): number {
  const c = TAX_FLAVOUR_COEFFS[flavour];
  const r = ctx.resources;
  let base = 0;
  switch (flavour) {
    case "worker":
      base = (c.perWorker ?? 0) * unitCount(units, "worker");
      break;
    case "weapon":
      base =
        (c.perSword ?? 0) * swordsHeld(ctx, units) +
        (c.perShield ?? 0) * shieldsHeld(ctx, units);
      break;
    case "building":
      base =
        (c.perSmithy ?? 0) * buildingCount(ctx, "smithy") +
        (c.perBarn ?? 0) * buildingCount(ctx, "barn") +
        (c.perBarracks ?? 0) * buildingCount(ctx, "barracks");
      break;
    case "housing":
      base = (c.perHouse ?? 0) * buildingCount(ctx, "house");
      break;
    case "animal":
      base = (c.perHorse ?? 0) * totalHorseCount(units, ctx.horses);
      break;
    case "wealth":
      base = Math.floor(r.gold / (c.goldDivisor ?? 1)) + (c.perDiamond ?? 0) * r.diamond;
      break;
    case "resource":
      base =
        Math.floor(r.wheat / (c.wheatDivisor ?? 1)) +
        Math.floor(r.wood / (c.woodDivisor ?? 1)) +
        Math.floor(r.meat / (c.meatDivisor ?? 1)) +
        Math.floor(r.stone / (c.stoneDivisor ?? 1)) +
        Math.floor(r.iron / (c.ironDivisor ?? 1));
      break;
  }
  return base + c.perYear * year;
}

// Open the tax event (§16.2, §16.2.1): roll a flavour and compute its gold demand,
// capped at TAX_MAX_GOLD_PER_YEAR × year so early years stay gentle. Nothing is
// auto-paid — the player chooses which goods/buildings to surrender via executeTax.
function startTax(ctx: SimCtx, units: Record<number, Unit>): ActiveEvent {
  const year = eventYear(ctx);
  let fv: number;
  [ctx.rngState, fv] = rngInt(ctx.rngState, 0, TAX_FLAVOURS.length - 1);
  const flavour = TAX_FLAVOURS[fv] ?? "worker";
  const demand = Math.min(taxDemand(ctx, units, flavour, year), year * TAX_MAX_GOLD_PER_YEAR);
  return { category: "tax", flavour, demand };
}

export interface TaxEval {
  ok: boolean; // the offer (or a forfeit) settles the event
  demand: number; // the gold demand to be covered
  contribution: number; // gold covered by the offered goods + buildings (may be fractional)
  shortfall: number; // demand − contribution, never below 0
  reason: string;
}

// Weigh a tax payment without mutating (§16.2.1). Goods are priced by
// resourceTaxGold (gold face value, diamonds +100%, other goods 50% of value);
// buildings cover buildingTaxValue. Contributions may be fractional and no change
// is given. Accepts when the offer meets the demand, or `forfeit` is set
// (surrender what's offered, the rest is forgiven).
export function evaluateTax(
  ctx: SimCtx,
  offerResources: Inventory,
  surrenderBuildingIds: number[],
  forfeit: boolean,
): TaxEval {
  const ev = ctx.activeEvent;
  const demand = ev && ev.category === "tax" ? ev.demand : 0;

  for (const t of RESOURCE_TYPES) {
    const want = offerResources[t] ?? 0;
    if (want > (ctx.resources[t] ?? 0)) {
      return { ok: false, demand, contribution: 0, shortfall: demand, reason: "Not enough goods to surrender" };
    }
  }
  let buildingValue = 0;
  for (const id of surrenderBuildingIds) {
    const b = ctx.buildings[id];
    if (!b) continue;
    if (b.kind === "mainHall") {
      return { ok: false, demand, contribution: 0, shortfall: demand, reason: "The Main Hall cannot be surrendered" };
    }
    buildingValue += buildingTaxValue(b.kind);
  }
  const contribution = resourceTaxGold(offerResources) + buildingValue;
  const shortfall = Math.max(0, demand - contribution);
  // Settle on a tiny epsilon so a fractional offer that sums to exactly the demand
  // isn't rejected by floating-point drift.
  if (demand <= 0 || contribution + 1e-9 >= demand) {
    return { ok: true, demand, contribution, shortfall: 0, reason: "" };
  }
  if (forfeit) {
    return { ok: true, demand, contribution, shortfall, reason: "Shortfall forgiven" };
  }
  return { ok: false, demand, contribution, shortfall, reason: "Offer does not cover the demand" };
}

// Apply a tax payment (§16.2) if it (or a forfeit) settles the event: deduct the
// offered goods, surrender the chosen buildings, then resolve the event. Returns
// whether the event was settled. A no-op (false) on an insufficient non-forfeit
// offer. Ejects occupants of surrendered buildings.
export function executeTax(
  ctx: SimCtx,
  units: Record<number, Unit>,
  offerResources: Inventory,
  surrenderBuildingIds: number[],
  forfeit: boolean,
): boolean {
  if (!ctx.activeEvent || ctx.activeEvent.category !== "tax") return false;
  const ev = evaluateTax(ctx, offerResources, surrenderBuildingIds, forfeit);
  if (!ev.ok) return false;

  for (const t of RESOURCE_TYPES) {
    const want = offerResources[t] ?? 0;
    if (want > 0) ctx.resources[t] = Math.max(0, (ctx.resources[t] ?? 0) - want);
  }
  for (const id of surrenderBuildingIds) {
    const b = ctx.buildings[id];
    if (!b || b.kind === "mainHall") continue;
    if (b.occupantId !== null) {
      const occ = units[b.occupantId];
      if (occ) units[occ.id] = { ...occ, insideBuildingId: null, order: { type: "idle" } };
    }
    delete ctx.buildings[id];
  }
  resolveEvent(ctx);
  return true;
}

// Dismiss a tax/misc event modal once the player acknowledges it. Valid for a
// Misc event (always) or a tax with no demand to settle (§16.2.1; a paid-down tax
// is dismissed by executeTax instead).
export function acknowledgeEvent(ctx: SimCtx): boolean {
  const ev = ctx.activeEvent;
  if (!ev) return false;
  if (ev.category === "misc" || (ev.category === "tax" && ev.demand <= 0)) {
    resolveEvent(ctx);
    return true;
  }
  return false;
}

// --- Misc events (§16.3) ---
// Apply the rolled misc event's effect and return a short human-readable summary
// for the modal. Magnitudes scale modestly with size/year; the seeded RNG keeps
// each roll deterministic.

function freeSpace(ctx: SimCtx): number {
  return Math.max(0, ctx.capacity - poolTotal(ctx.resources));
}

// Result of firing a Misc event: a one-line summary for the modal, plus, for the
// four trade-dialog events (§16.3, item 32), the trade state the modal drives.
// Non-trade events apply their effect immediately and leave `trade` undefined.
interface MiscResult {
  summary: string;
  trade?: MiscTradeState;
}

// Opening blurb for each trade-dialog event (§16.3). The effect itself is the
// player's choices in the modal, so these just set the scene.
const MISC_TRADE_INTRO: Record<MiscTradeKind, string> = {
  mercenaries: "Mercenaries offer their blades for gold. Hire who you can, then send them on.",
  forestAlchemist: "A forest alchemist will transmute your wood and wheat. Trade while it lingers.",
  migrants: "Migrants seek a home. Take them in for food or gold, then close the gates.",
  trader: "A travelling trader opens shop — buy and sell at town prices until it leaves.",
};

// Soldiers and Captains share the Barracks housing pool (§7.4).
function militaryCount(units: Record<number, Unit>): number {
  let n = 0;
  for (const u of Object.values(units)) if (u.kind === "soldier" || u.kind === "captain") n++;
  return n;
}

// Is there a free housing slot for a unit of `kind` (§7.4)? Workers → Houses;
// Soldiers/Captains → Barracks.
function hasHousingFor(ctx: SimCtx, units: Record<number, Unit>, kind: UnitKind): boolean {
  return kind === "worker"
    ? unitCount(units, "worker") < workerHousingCap(ctx.buildings)
    : militaryCount(units) < barracksHousingCap(ctx.buildings);
}

// A walkable tile next to the Main Hall to drop a freshly arrived unit on,
// preferring one no other unit stands on so recruits don't pile up. Falls back to
// any walkable neighbour. Null if the hall is boxed in (or absent).
function hallSpawnSpot(ctx: SimCtx, units: Record<number, Unit>): TileCoord | null {
  const hall = Object.values(ctx.buildings).find((b) => b.kind === "mainHall");
  if (!hall) return null;
  const occupied = new Set<string>();
  for (const u of Object.values(units)) occupied.add(`${Math.round(u.x)},${Math.round(u.y)}`);
  let fallback: TileCoord | null = null;
  for (const n of hexNeighbors(hall.x, hall.y)) {
    if (!isWalkable(ctx.map, n.x, n.y, ctx.buildings)) continue;
    fallback ??= n;
    if (!occupied.has(`${n.x},${n.y}`)) return n;
  }
  return fallback;
}

// Can a unit of `kind` appear right now — both a free housing slot and a tile to
// stand on (§7.4)? Used to gate Misc recruits before any cost is paid.
function canSpawnUnit(ctx: SimCtx, units: Record<number, Unit>, kind: UnitKind): boolean {
  return hasHousingFor(ctx, units, kind) && hallSpawnSpot(ctx, units) !== null;
}

// Spawn a unit of `kind` next to the Main Hall; returns false (spawning nothing)
// if there is no housing or no free tile. Caller must have already paid any cost.
function spawnUnitNearHall(ctx: SimCtx, units: Record<number, Unit>, kind: UnitKind): boolean {
  const spot = hallSpawnSpot(ctx, units);
  if (!spot || !hasHousingFor(ctx, units, kind)) return false;
  const id = ctx.nextId++;
  units[id] = makeUnit(id, kind, spot.x, spot.y);
  return true;
}

// A buildable grass/stump tile adjacent to an existing building, for auto-placing
// the Neighbors gift (§16.3). Scans every building's neighbours; placementValid
// already excludes occupied tiles, so adding the first gift to `ctx.buildings`
// before searching for the second keeps them apart.
function freeGrassNearBuildings(ctx: SimCtx): TileCoord | null {
  for (const b of Object.values(ctx.buildings)) {
    for (const n of hexNeighbors(b.x, b.y)) {
      if (placementValid(ctx.map, ctx.buildings, ctx.fields, "house", n.x, n.y, ctx.town)) return n;
    }
  }
  return null;
}

// Place a fully-built gift building near the hamlet (Neighbors, §16.3). Returns
// whether it found room.
function giftBuilding(ctx: SimCtx, kind: BuildingKind): boolean {
  const spot = freeGrassNearBuildings(ctx);
  if (!spot) return false;
  const id = ctx.nextId++;
  ctx.buildings[id] = makeBuilding(id, kind, spot.x, spot.y, { built: true });
  return true;
}

function applyMiscEvent(ctx: SimCtx, units: Record<number, Unit>, misc: MiscEventKind): MiscResult {
  switch (misc) {
    // --- Trade-dialog events (§16.3, item 32): no up-front effect; the player
    // strikes deals from the modal via miscTrade commands until they close it.
    case "mercenaries":
    case "forestAlchemist":
    case "migrants":
    case "trader":
      return { summary: MISC_TRADE_INTRO[misc], trade: { kind: misc, purchases: {} } };

    case "bountifulHarvest": {
      // +50% of the single most-stored resource, capped at the storage limit.
      let best: ResourceType | null = null;
      for (const t of RESOURCE_TYPES) {
        if (ctx.resources[t] > 0 && (best === null || ctx.resources[t] > ctx.resources[best])) best = t;
      }
      if (!best) return { summary: "A bountiful harvest, but the stores were bare." };
      const gain = Math.min(Math.ceil(ctx.resources[best] * BOUNTIFUL_HARVEST_FRACTION), freeSpace(ctx));
      ctx.resources[best] += gain;
      return { summary: `Bountiful Harvest: +${gain} ${best}.` };
    }
    case "cropBlight": {
      const lost = Math.floor(ctx.resources.wheat * CROP_BLIGHT_FRACTION);
      ctx.resources.wheat -= lost;
      return { summary: `Crop Blight: ${lost} wheat destroyed.` };
    }
    case "blight": {
      // Distinct from Crop Blight: −25% wheat and −25% meat.
      const wheat = Math.floor(ctx.resources.wheat * BLIGHT_FRACTION);
      const meat = Math.floor(ctx.resources.meat * BLIGHT_FRACTION);
      ctx.resources.wheat -= wheat;
      ctx.resources.meat -= meat;
      return { summary: `Blight: ${wheat} wheat and ${meat} meat spoiled.` };
    }
    case "plague": {
      let pick: number;
      [ctx.rngState, pick] = rngNext(ctx.rngState);
      if (pick < 0.5) {
        // Lose one random non-captain unit.
        const ids = Object.values(units).filter((u) => u.kind !== "captain").map((u) => u.id);
        if (ids.length === 0) return { summary: "Plague passes — no one falls ill." };
        let k: number;
        [ctx.rngState, k] = rngInt(ctx.rngState, 0, ids.length - 1);
        const victim = units[ids[k]];
        if (victim) releaseOccupancy(ctx, victim);
        delete units[ids[k]];
        return { summary: "Plague: a unit was lost to illness." };
      }
      // −25% of max HP across all units; any dropping to 0 dies (§16.3).
      let died = 0;
      for (const key of Object.keys(units)) {
        const u = units[Number(key)];
        const hp = u.hp - Math.ceil(UNIT_MAX_HP[u.kind] * PLAGUE_HP_FRACTION);
        if (hp <= 0) { releaseOccupancy(ctx, u); delete units[u.id]; died++; }
        else units[u.id] = { ...u, hp };
      }
      return { summary: died > 0 ? `Plague: −25% HP to all; ${died} perished.` : "Plague: −25% HP to all units." };
    }
    case "festival":
      ctx.eventMods = { ...ctx.eventMods, festival: true };
      return { summary: "Festival: +25% gathering and −25% build/craft/train this year." };
    case "mildWinter":
      ctx.eventMods = { ...ctx.eventMods, mildWinter: true };
      return { summary: "Mild Winter: no winter fishing penalty or worker upkeep this year." };
    case "harshWinter":
      ctx.eventMods = { ...ctx.eventMods, harshUpkeep: true };
      return { summary: "Harsh Winter: the next season's upkeep is doubled." };
    case "storageThief": {
      // Steal 50% of one random stored resource (no combat).
      const held = RESOURCE_TYPES.filter((t) => ctx.resources[t] > 0);
      if (held.length === 0) return { summary: "Storage Thief: the thief found nothing." };
      let k: number;
      [ctx.rngState, k] = rngInt(ctx.rngState, 0, held.length - 1);
      const t = held[k];
      const stolen = Math.ceil(ctx.resources[t] * STORAGE_THIEF_FRACTION);
      ctx.resources[t] -= stolen;
      return { summary: `Storage Thief: ${stolen} ${t} stolen.` };
    }
    case "woodBoon": {
      const gain = Math.min(Math.ceil(ctx.resources.wood * WOOD_BOON_FRACTION), freeSpace(ctx));
      ctx.resources.wood += gain;
      return { summary: `Wood Boon: +${gain} wood.` };
    }
    case "barnFire": {
      // Lose 50% wood + 50% wheat, and one barn if 2+ barns stand.
      const wood = Math.floor(ctx.resources.wood * BARN_FIRE_FRACTION);
      const wheat = Math.floor(ctx.resources.wheat * BARN_FIRE_FRACTION);
      ctx.resources.wood -= wood;
      ctx.resources.wheat -= wheat;
      let barnLost = false;
      if (buildingCount(ctx, "barn") >= 2) {
        const barn = Object.values(ctx.buildings).find((b) => b.kind === "barn");
        if (barn) { delete ctx.buildings[barn.id]; barnLost = true; }
      }
      return {
        summary: `Barn Fire: ${wood} wood and ${wheat} wheat burned${barnLost ? ", a barn collapsed" : ""}.`,
      };
    }
    case "termites": {
      // Gain 1 meat per 5 wood, then lose 75% of stored wood (§16.3). Remove the
      // wood first so the salvaged meat has the most storage headroom.
      const woodBefore = ctx.resources.wood;
      const meatGain = Math.floor(woodBefore / TERMITES_MEAT_PER_WOOD);
      const woodLost = Math.floor(woodBefore * TERMITES_WOOD_LOSS_FRACTION);
      ctx.resources.wood -= woodLost;
      const meat = Math.min(meatGain, freeSpace(ctx));
      ctx.resources.meat += meat;
      return { summary: `Termites: ${woodLost} wood eaten, +${meat} meat salvaged.` };
    }
    case "midasTouch": {
      // Gain 1 gold per 5 meat, then lose 25% of stored meat (§16.3).
      const meatBefore = ctx.resources.meat;
      const goldGain = Math.floor(meatBefore / MIDAS_GOLD_PER_MEAT);
      const meatLost = Math.floor(meatBefore * MIDAS_MEAT_LOSS_FRACTION);
      ctx.resources.meat -= meatLost;
      const gold = Math.min(goldGain, freeSpace(ctx));
      ctx.resources.gold += gold;
      return { summary: `Midas Touch: +${gold} gold for ${meatLost} meat.` };
    }
    case "neighbors": {
      // Gift one house + one barn, auto-placed on grass near the hamlet (§16.3).
      const house = giftBuilding(ctx, "house");
      const barn = giftBuilding(ctx, "barn");
      const got = [house ? "a house" : null, barn ? "a barn" : null].filter(Boolean);
      return {
        summary: got.length ? `Neighbors raise ${got.join(" and ")} for you.` : "Neighbors offered help, but found no room to build.",
      };
    }
    case "migrantLaborers": {
      // Workers arrive until every House is full (§16.3).
      let arrived = 0;
      while (spawnUnitNearHall(ctx, units, "worker")) arrived++;
      return { summary: arrived > 0 ? `Migrant Laborers: ${arrived} worker(s) join the hamlet.` : "Migrant Laborers came, but the houses were full." };
    }
    case "lostCaravan": {
      // A small random windfall into storage (e.g., wood + iron), capped by space.
      const choices: ResourceType[] = ["wood", "stone", "iron", "wheat", "meat"];
      const got: string[] = [];
      for (let i = 0; i < 2; i++) {
        let k: number;
        [ctx.rngState, k] = rngInt(ctx.rngState, 0, choices.length - 1);
        let qty: number;
        [ctx.rngState, qty] = rngInt(ctx.rngState, LOST_CARAVAN_MIN, LOST_CARAVAN_MAX);
        const t = choices[k];
        const add = Math.min(qty, freeSpace(ctx));
        ctx.resources[t] += add;
        if (add > 0) got.push(`${add} ${t}`);
      }
      return { summary: got.length ? `Lost Caravan: found ${got.join(", ")}.` : "Lost Caravan: stores were full." };
    }
  }
}

// --- Misc trade dialogs (§16.3, item 32) ---
// Execute one fixed offer of the resolving trade-dialog event. Deterministic (no
// RNG): pays the offer's cost from the hamlet pool and lands its yield, enforcing
// the per-offer cap, storage limit, and housing. A no-op (changes nothing) if the
// offer is unknown, capped, unaffordable, or its yield cannot land — the modal
// disables most of these, but the sim is the authority.
export function applyMiscTrade(
  ctx: SimCtx,
  units: Record<number, Unit>,
  offerId: string,
): void {
  const ev = ctx.activeEvent;
  if (!ev || ev.category !== "misc" || !ev.trade) return;
  const offer = MISC_TRADE_OFFERS[ev.trade.kind].find((o) => o.id === offerId);
  if (!offer) return;

  // Per-offer purchase cap (§16.3 — e.g. Mercenaries: 1 captain, 3 soldiers).
  const taken = ev.trade.purchases[offerId] ?? 0;
  if (offer.max !== undefined && taken >= offer.max) return;

  // Affordable from the pool?
  for (const t of RESOURCE_TYPES) {
    if (ctx.resources[t] < (offer.cost[t] ?? 0)) return;
  }

  // Yield must be able to land before any cost is taken.
  if (offer.gainResources) {
    let costTotal = 0;
    let gainTotal = 0;
    for (const t of RESOURCE_TYPES) {
      costTotal += offer.cost[t] ?? 0;
      gainTotal += offer.gainResources[t] ?? 0;
    }
    // Resource acquisition is capped at the storage limit (§16.3): reject a buy
    // that would overflow rather than truncating a value-exact trade.
    if (poolTotal(ctx.resources) - costTotal + gainTotal > ctx.capacity) return;
  }
  if (offer.gainUnit && !canSpawnUnit(ctx, units, offer.gainUnit)) return;

  // Pay, then deliver.
  for (const t of RESOURCE_TYPES) {
    const c = offer.cost[t] ?? 0;
    if (c) ctx.resources[t] -= c;
  }
  if (offer.gainResources) {
    for (const t of RESOURCE_TYPES) {
      const g = offer.gainResources[t] ?? 0;
      if (g) ctx.resources[t] += g;
    }
  }
  if (offer.gainUnit) spawnUnitNearHall(ctx, units, offer.gainUnit);
  if (offer.gainEquipment) ctx.equipment[offer.gainEquipment]++;

  ev.trade.purchases[offerId] = taken + 1;
}

// --- Build / repair (req §7, §7.1) ---
//
// The build order targets either a Building (positive id) or a Stables tile
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

  // A builder only works while centred on a tile (req §7.1). When the build site
  // is the unit's own tile the path is empty and stepPath leaves it wherever it
  // happened to stop (e.g. mid-tile after a march), so snap to the tile centre
  // before any construction progress accrues — otherwise a building (a Mine in
  // particular) can finish with its builder standing between tiles.
  if (phase === "working") {
    x = Math.round(x);
    y = Math.round(y);
  }

  if (buildingId >= 0) {
    // Building target.
    const b = ctx.buildings[buildingId];
    if (!b) return { ...unit, x, y, order: { type: "idle" } };
    if (phase === "working" && timeLeft > 0) {
      const wm = festivalWorkMult(ctx);
      if (repair) {
        const totalTicks = BUILD_TICKS[b.kind] * wm;
        const hpPerTick = b.maxHp / totalTicks;
        const newHp = Math.min(b.maxHp, b.hp + hpPerTick * timeLeft);
        ctx.buildings[buildingId] = { ...b, hp: newHp };
        if (newHp >= b.maxHp) return { ...unit, x, y, order: { type: "idle" } };
      } else {
        const totalTicks = BUILD_TICKS[b.kind] * wm;
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
    // Stables target. buildingId is `-fieldId`.
    const fid = -buildingId;
    const f = ctx.fields[fid];
    if (!f || f.stage !== "stablesBuilding") {
      return { ...unit, x, y, order: { type: "idle" } };
    }
    if (phase === "working" && timeLeft > 0) {
      const stablesTotal = STABLES_BUILD_TICKS * festivalWorkMult(ctx);
      const newProgress = Math.min(stablesTotal, f.buildProgress + timeLeft);
      const matured = newProgress >= stablesTotal;
      ctx.fields[fid] = {
        ...f,
        buildProgress: newProgress,
        stage: matured ? "stablesMature" : "stablesBuilding",
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

  // Both sides fight from tile centres. The enemy may be mid-march, so
  // judge adjacency on its current tile.
  const ex = Math.round(enemy.x);
  const ey = Math.round(enemy.y);
  const ux = Math.round(unit.x);
  const uy = Math.round(unit.y);

  // Adjacent: stop on the centre of the current tile and hold (combat pass
  // swings). Snapping to (ux, uy) keeps the unit from engaging from a fractional
  // mid-tile position once its rounded hex is already adjacent.
  if (hexDistance({ x: ux, y: uy }, { x: ex, y: ey }) <= 1) {
    return { ...unit, x: ux, y: uy, order: { type: "attack", targetId: o.targetId, path: [], node: 0 } };
  }

  // Need to close in. Re-path to a walkable hex adjacent to the enemy when our
  // current path is spent (also covers the enemy having moved).
  let path = o.path;
  let node = o.node;
  if (node >= path.length) {
    const np = pathAdjacentTo(ctx.map, unit, ex, ey, ctx.buildings);
    if (!np || np.length === 0) return { ...unit, order: { type: "idle" } };
    path = np;
    node = 0;
  }
  const r = stepPath(unit.x, unit.y, path, node, moveSpeed(unit).tilesPerTick * dtTicks);
  // Arrived adjacent this step: settle on the tile centre to fight so the
  // combat pass swings from a hex centre rather than a fractional mid-tile spot.
  if (hexDistance({ x: Math.round(r.x), y: Math.round(r.y) }, { x: ex, y: ey }) <= 1) {
    return {
      ...unit,
      x: Math.round(r.x),
      y: Math.round(r.y),
      order: { type: "attack", targetId: o.targetId, path: [], node: 0 },
    };
  }
  return { ...unit, x: r.x, y: r.y, order: { type: "attack", targetId: o.targetId, path, node: r.node } };
}

// --- Horse stabling capacity (req §9) ---
// Each mature Stables houses STABLES_HORSE_CAPACITY horses. A horse can
// only be bought while at least one stable slot is free; a horse occupies a slot
// for as long as it's alive (`horseHp > 0`).

// Total horses the hamlet's mature Stables can house.
export function horseStableCapacity(fields: Record<number, Field>): number {
  let mature = 0;
  for (const f of Object.values(fields)) if (f.stage === "stablesMature") mature++;
  return mature * STABLES_HORSE_CAPACITY;
}

// How many units are currently mounted (each occupies one stable slot).
export function mountedUnitCount(units: Record<number, Unit>): number {
  let n = 0;
  for (const u of Object.values(units)) if (u.horseHp > 0) n++;
  return n;
}

// Every horse the hamlet owns counts against stable capacity (req §9): the ones
// being ridden (`Unit.horseHp`) plus the riderless ones waiting at/walking to a
// Stables. Dismount and mount just move a horse between these two pools, so the
// total — and therefore stable usage — is conserved.
export function totalHorseCount(
  units: Record<number, Unit>,
  horses: Record<number, Horse>,
): number {
  return mountedUnitCount(units) + Object.keys(horses).length;
}

// Is there a free stable slot for one more horse? (req §9 — blocks the purchase.)
export function hasFreeStable(
  units: Record<number, Unit>,
  fields: Record<number, Field>,
  horses: Record<number, Horse>,
): boolean {
  return totalHorseCount(units, horses) < horseStableCapacity(fields);
}

// Is (x, y) a mature Stables tile a horse can park on?
function onMatureStables(ctx: SimCtx, x: number, y: number): boolean {
  const f = fieldAt(ctx.fields, x, y);
  return !!f && f.stage === "stablesMature";
}

// The nearest mature-Stables tile reachable from (x, y), or null when there is
// none (no Stables built, or none with a valid path). Ties break on hex distance.
function nearestStablesTile(ctx: SimCtx, x: number, y: number): TileCoord | null {
  const cands = Object.values(ctx.fields)
    .filter((f) => f.stage === "stablesMature")
    .map((f) => ({ x: f.x, y: f.y, d: hexDistance({ x, y }, { x: f.x, y: f.y }) }))
    .sort((a, b) => a.d - b.d);
  for (const c of cands) {
    if (c.x === x && c.y === y) return { x: c.x, y: c.y };
    if (findPath(ctx.map, { x, y }, { x: c.x, y: c.y }, ctx.buildings)) return { x: c.x, y: c.y };
  }
  return null;
}

// A riderless horse trots home at the mounted travel speed (req §9).
const HORSE_TILES_PER_TICK = TILES_PER_TICK * HORSE_SPEED_MULT;

// Dismount (req §9): the rider gives up its horse. The horse appears at the
// unit's tile as a riderless entity (keeping its buffer HP) and is routed to the
// nearest Stables; the unit drops to foot stats but keeps its current order.
export function startDismount(ctx: SimCtx, unit: Unit): Unit {
  if (!hasHorse(unit)) return unit;
  const hx = Math.round(unit.x);
  const hy = Math.round(unit.y);
  const dest = nearestStablesTile(ctx, hx, hy);
  const path = dest ? findPath(ctx.map, { x: hx, y: hy }, dest, ctx.buildings) ?? [] : [];
  const id = ctx.nextId++;
  ctx.horses[id] = makeHorse(id, hx, hy, unit.horseHp, path);
  return { ...unit, horseHp: 0 };
}

// Mount (req §9): build an order that sends the unit to the nearest riderless
// horse. No-op (keeps the current order) if the unit already has a horse or no
// reachable horse exists.
export function startMount(ctx: SimCtx, unit: Unit): Order {
  if (hasHorse(unit)) return unit.order;
  const ux = Math.round(unit.x);
  const uy = Math.round(unit.y);
  let best: Horse | null = null;
  let bestPath: TileCoord[] | null = null;
  let bestD = Infinity;
  for (const h of Object.values(ctx.horses)) {
    const d = hexDistance({ x: ux, y: uy }, { x: Math.round(h.x), y: Math.round(h.y) });
    if (d >= bestD) continue;
    const path =
      d <= 1
        ? []
        : pathFromUnit(ctx.map, unit, { x: Math.round(h.x), y: Math.round(h.y) }, ctx.buildings) ??
          pathAdjacentTo(ctx.map, unit, Math.round(h.x), Math.round(h.y), ctx.buildings);
    if (!path) continue;
    best = h;
    bestPath = path;
    bestD = d;
  }
  if (!best || !bestPath) return unit.order;
  return { type: "mount", horseId: best.id, path: bestPath, node: 0 };
}

// Advance a `mount` order: walk toward the target horse and climb on once
// adjacent, consuming the horse entity and reclaiming its buffer HP. If the
// horse has moved on (still trotting to the stables) the path is recomputed; the
// order ends if the horse is gone (taken by someone else) or unreachable.
function advanceMount(unit: Unit, dtTicks: number, ctx: SimCtx): Unit {
  const o = unit.order;
  if (o.type !== "mount") return unit;
  const horse = ctx.horses[o.horseId];
  if (!horse) return { ...unit, order: { type: "idle" } };

  const spd = moveSpeed(unit);
  const r = stepPath(unit.x, unit.y, o.path, o.node, dtTicks * spd.tilesPerTick);
  const x = r.x;
  const y = r.y;

  const adjacent =
    hexDistance({ x: Math.round(x), y: Math.round(y) }, { x: Math.round(horse.x), y: Math.round(horse.y) }) <= 1;
  if (adjacent) {
    delete ctx.horses[horse.id]; // absorbed back into the rider
    return { ...unit, x: Math.round(x), y: Math.round(y), horseHp: horse.hp, order: { type: "idle" } };
  }
  if (r.node >= o.path.length) {
    // Reached the end of the path but the horse moved — chase its new tile.
    const np =
      pathFromUnit(ctx.map, { ...unit, x, y }, { x: Math.round(horse.x), y: Math.round(horse.y) }, ctx.buildings) ??
      pathAdjacentTo(ctx.map, { ...unit, x, y }, Math.round(horse.x), Math.round(horse.y), ctx.buildings);
    if (!np) return { ...unit, x, y, order: { type: "idle" } };
    return { ...unit, x, y, order: { type: "mount", horseId: horse.id, path: np, node: 0 } };
  }
  return { ...unit, x, y, order: { type: "mount", horseId: horse.id, path: o.path, node: r.node } };
}

// Advance one riderless horse (req §9): trot along its route to the nearest
// Stables and park there. A horse with no route (e.g. dismounted before any
// Stables existed) re-checks for one each step and sets off once it can.
function advanceHorse(horse: Horse, dtTicks: number, ctx: SimCtx): Horse {
  if (horse.stabled) return horse;
  let { x, y, node, path } = horse;

  if (node >= path.length) {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (onMatureStables(ctx, rx, ry)) {
      return { ...horse, x: rx, y: ry, path: [], node: 0, stabled: true };
    }
    const dest = nearestStablesTile(ctx, rx, ry);
    if (!dest) return horse; // nowhere to go yet — wait in place
    const p = findPath(ctx.map, { x: rx, y: ry }, dest, ctx.buildings);
    if (!p || p.length === 0) return horse;
    path = p;
    node = 0;
  }

  const r = stepPath(x, y, path, node, HORSE_TILES_PER_TICK * dtTicks);
  x = r.x;
  y = r.y;
  node = r.node;
  if (node >= path.length) {
    const sx = Math.round(x);
    const sy = Math.round(y);
    const parked = onMatureStables(ctx, sx, sy);
    return { ...horse, x: sx, y: sy, node, path: parked ? [] : path, stabled: parked };
  }
  return { ...horse, x, y, node, path };
}

// Advance every riderless horse one step (req §9). Called from update() each tick.
export function advanceHorses(ctx: SimCtx, dtTicks: number): void {
  for (const key of Object.keys(ctx.horses)) {
    const id = Number(key);
    ctx.horses[id] = advanceHorse(ctx.horses[id], dtTicks, ctx);
  }
}

// --- Trade: travel to town, then exchange goods at listed values (req §18) ---

function advanceTrade(unit: Unit, dtTicks: number, ctx: SimCtx, units: Record<number, Unit>): Unit {
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

  // Trade (and then rest) from the tile centre, not a fractional mid-tile spot —
  // an empty path (already at the town tile) otherwise leaves the unit off-centre.
  if (phase === "trading") {
    x = Math.round(x);
    y = Math.round(y);
  }

  if (phase === "trading") {
    // A horse may only be bought when a Stables slot is free (req §9).
    const canHorse = buyHorse && hasFreeStable(units, ctx.fields, ctx.horses);
    return resolveTrade({ ...unit, x, y }, sell, buy, canHorse);
  }

  return { ...unit, x, y, order: { type: "trade", tx, ty, sell, buy, buyHorse, phase, path, node } };
}

// Resolve a town transaction against the unit's carried inventory (req §18, §8).
// Selling converts carried resources to value; buying (and a horse) spends it.
// The trade is rejected (unit just goes idle) if proceeds can't cover the cost.
// Any surplus value is returned as gold (whole coins); a sub-coin (<10)
// remainder is forfeited to the shopkeeper, since gold is the smallest currency
// now that hay is no longer a resource (req §8).
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

  // Return surplus value as change — gold coins plus wood/wheat for the sub-coin
  // remainder; only an indivisible value of 1 is lost (req §18, see makeChange).
  const change = makeChange(credit - cost);
  for (const t of RESOURCE_TYPES) {
    const amt = change[t] ?? 0;
    if (amt > 0) carrying[t] = (carrying[t] ?? 0) + amt;
  }

  return { ...unit, carrying, horseHp, order: { type: "idle" } };
}

// --- Interactive town interface (req §18) ---
// A unit standing at (or next to) the town tile opens the marketplace UI, which
// drives these helpers via `townStore` / `townTrade` commands. Unlike the
// automatic `trade` order above, these resolve instantly against a unit already
// at town — no travel, no `order` change.

// Is the unit standing on any of the seven town tiles (req §18)? Trading works
// from anywhere in the town flower, not just the central market tile.
export function isUnitAtTown(unit: Unit, town: TileCoord): boolean {
  return isTownTile(town, Math.round(unit.x), Math.round(unit.y));
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
  if (!canCarryResource(unit, resource)) return unit; // captains take only gold/diamond (§6.1)
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
  change: Inventory; // surplus returned to town storage (gold + wood/wheat)
}

// Weigh a proposed trade without mutating anything (req §18). The shopkeeper
// accepts when the offered value meets or beats the cart value; surplus is
// returned to town storage as gold (whole coins; a <10 remainder is forfeited).
// Also rejects an empty cart, an offer the unit/town can't back, and a cart
// that won't fit in the unit's carry capacity once the offered-away goods leave.
export function evaluateTownTrade(
  unit: Unit,
  townStorage: ResourcePool,
  cart: Inventory,
  buyHorse: boolean,
  offerUnit: Inventory,
  offerStorage: Inventory,
  freeStable: boolean,
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
    change: {},
  };

  if (cartCount === 0 && !wantHorse) {
    return { ...base, reason: "Cart is empty" };
  }
  // Captains can only carry gold and diamonds home (req §6.1).
  for (const t of RESOURCE_TYPES) {
    if ((cart[t] ?? 0) > 0 && !canCarryResource(unit, t)) {
      return { ...base, reason: "Captains can carry only gold and diamonds" };
    }
  }
  // A horse needs a free Stables slot (req §9).
  if (wantHorse && !freeStable) {
    return { ...base, reason: "No free stable — build a Stables first" };
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

  return { ...base, ok: true, change: makeChange(base.offerValue - cartValue) };
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
  units: Record<number, Unit>,
): Unit | null {
  if (!isUnitAtTown(unit, ctx.town)) return null;
  const freeStable = hasFreeStable(units, ctx.fields, ctx.horses);
  const ev = evaluateTownTrade(unit, ctx.townStorage, cart, buyHorse, offerUnit, offerStorage, freeStable);
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
  // Return change to town storage (gold + wood/wheat) so it never overflows carry.
  for (const t of RESOURCE_TYPES) {
    const amt = ev.change[t] ?? 0;
    if (amt > 0) ctx.townStorage[t] += amt;
  }

  return { ...unit, carrying, horseHp };
}

// --- Hall / storage loading interface ---
// A worker on or beside a built storage building (Main Hall, Barn, …) opens a
// load/unload panel. Unlike the town interface — which uses the separate
// `townStorage` pool — these transfers move goods between the unit's inventory
// and the hamlet's shared `resources` pool, so they respect the storage cap.

// Is the unit standing on, or directly next to, this building's tile?
export function isUnitAtBuilding(unit: Unit, b: Building): boolean {
  return hexDistance({ x: Math.round(unit.x), y: Math.round(unit.y) }, b) <= 1;
}

// Move `amount` of one resource between the unit's inventory and the hamlet pool
// via `building`. `toStorage` true = unit → pool, clamped to the pool's free
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
  if (!canCarryResource(unit, resource)) return unit; // captains take only gold/diamond (§6.1)
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
    // occupant gate the smithy/barracks rely on.
    if (b.kind === "mainHall") {
      if (b.spawning) tickMainHall(ctx, id, dtTicks, units);
      continue;
    }
    if (b.occupantId === null) continue;
    const op = units[b.occupantId];
    if (!op || op.insideBuildingId !== id) continue;

    if (b.kind === "smithy") tickSmithy(ctx, id, dtTicks, units);
    else if (b.kind === "barracks") tickBarracks(ctx, id, dtTicks, units);
  }
}

// Raise a worker at the Main Hall. Accumulates ticks until
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
  const spawnTotal = WORKER_SPAWN_TICKS * festivalWorkMult(ctx);
  const newProgress = b.spawnProgress + dtTicks;
  if (newProgress < spawnTotal) {
    ctx.buildings[id] = { ...b, spawnProgress: newProgress };
    return;
  }
  if (unitCount(units, "worker") >= workerHousingCap(ctx.buildings)) {
    ctx.buildings[id] = { ...b, spawnProgress: spawnTotal };
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

function tickSmithy(ctx: SimCtx, id: number, dtTicks: number, units: Record<number, Unit>): void {
  let b = ctx.buildings[id];
  if (b.occupantId === null) return;
  const op = units[b.occupantId];
  // The order is what tells the smithy which item to make; the operator's
  // order is the source of truth so cancellation is a single edit.
  if (!op || op.order.type !== "operate") return;
  const item: CraftItem | null =
    op.order.mode === "craftSword" ? "sword"
    : op.order.mode === "craftShield" ? "shield"
    : null;
  if (!item) return;
  if (b.craftItem !== item) {
    // Operator switched item or just arrived: reset progress to the new item.
    b = { ...b, craftItem: item, craftProgress: 0 };
    ctx.buildings[id] = b;
  }
  const craftTotal = CRAFT_TICKS[item] * festivalWorkMult(ctx);
  const need = craftTotal - b.craftProgress;
  if (dtTicks < need) {
    ctx.buildings[id] = { ...b, craftProgress: b.craftProgress + dtTicks };
    return;
  }
  // One item's worth of progress has accumulated. Deduct cost if we can afford
  // it and post the output; otherwise stall progress at the cap.
  const cost = CRAFT_COST[item];
  if (!canAfford(ctx.resources, cost)) {
    ctx.buildings[id] = { ...b, craftProgress: craftTotal };
    return;
  }
  payCost(ctx.resources, cost);
  ctx.equipment[item]++;
  // A craft order makes exactly one item then stops (req §7.2): eject the
  // operator to stand idle and free the smithy, rather than looping production.
  units[op.id] = { ...op, insideBuildingId: null, order: { type: "idle" }, x: b.x, y: b.y };
  ctx.buildings[id] = { ...b, occupantId: null, craftItem: null, craftProgress: 0 };
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
  if (newProgress < TRAIN_TICKS * festivalWorkMult(ctx)) {
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
