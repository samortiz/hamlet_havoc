// Combat (req §17). One resolver handles all fighting — year-end attacks, mine
// goblins, and serpent/kraken fishing attacks all flow through `stepCombat`.
// Adjacent opposing entities trade blows once per second; each hit rolls a
// random integer in the attacker's range, subtracts the defender's defense
// (min 0), and applies the damage. A horse's buffer HP soaks damage first.
//
// Plain, id-based data like every other entity (req §2.6): enemies live in a
// `Record<number, Enemy>` on GameState. The resolver covers the player's
// attack/defend behavior and the enemy AI: land goblins march toward (and
// batter) the nearest unit or building, while water predators (sea serpent /
// kraken) hunt *within the water*, pathing to a water tile beside the nearest
// reachable unit and striking from there — they never leave the water (req §14).

import {
  ATTACK_INTERVAL_TICKS,
  type Dice,
  ENEMY_MOVE_TILES_PER_SEC,
  ENEMY_STATS,
  LOOT,
  SHIELD_DEFENSE_DICE,
  SWORD_ATTACK_DICE,
  TICKS_PER_SECOND,
  UNIT_ATTACK,
  UNIT_DEFENSE,
} from "../config/index.js";
import { type Building } from "./buildings.js";
import { hexDistance, hexNeighbors } from "./hex.js";
import { findPath, findWaterPath } from "./pathfinding.js";
import { inBounds, isWalkable, tileAt, type GameMap, type TileCoord } from "./map.js";
import { rngInt } from "./rng.js";
import { carriedTotal, type Inventory, type ResourceType } from "./resources.js";
import { canCarryResource, carryCap, type Unit } from "./units.js";
import type { GroundItem } from "./state.js";

// The six enemy kinds (req §6.1). Land enemies (giant spider, goblin, goblin
// chief, dragon) march on the hamlet via the AI below; water predators (sea
// serpent, kraken) never leave the water (req §17.3).
export type EnemyKind =
  | "giantSpider"
  | "goblin"
  | "goblinChief"
  | "seaSerpent"
  | "kraken"
  | "dragon";

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number; // tile-space (fractional while an enemy is moving)
  y: number;
  hp: number;
  attackCooldown: number; // ticks until next swing (req §17.1)
  // Enemy AI. `focusUnitId` is a preferred target — a mine goblin focuses the miner
  // (req §13.2); null means "pick the nearest target". Water predators ignore it.
  // `path`/`node` carry the current march toward the target: a goblin paths over
  // land, a water predator over water (req §14); both stay empty while holding.
  focusUnitId: number | null;
  path: TileCoord[];
  node: number;
  // Tick a water predator surfaced (req §17.3). Aligned to the start of its spawn
  // season so it despawns at the start of that same season one year later. Unused
  // by land enemies (they persist until killed).
  spawnTick: number;
}

// A single hit landed this step, surfaced for the render layer to float a small
// "-N" toast over the struck combatant. Transient: produced fresh every
// `update()` step, consumed by the renderer, never persisted (see persistence.ts).
// `(x, y)` is the victim's tile-space position; `target` lets the renderer tint
// damage to our own units differently from damage we deal to enemies.
export interface DamageEvent {
  x: number;
  y: number;
  amount: number;
  target: "unit" | "enemy";
}

// A heal applied to a unit this step (req §6.2), the green mirror of DamageEvent:
// the renderer floats a "+N" toast over the unit. Transient like DamageEvent —
// produced fresh every step, consumed by the renderer, never persisted.
export interface HealEvent {
  x: number;
  y: number;
  amount: number;
}

// Water predators (sea serpent / kraken) never leave the water (req §17.3).
export function isWaterEnemy(kind: EnemyKind): boolean {
  return kind === "seaSerpent" || kind === "kraken";
}

export function makeEnemy(
  id: number,
  kind: EnemyKind,
  x: number,
  y: number,
  focusUnitId: number | null = null,
  spawnTick = 0,
): Enemy {
  return {
    id,
    kind,
    x,
    y,
    hp: ENEMY_STATS[kind].hp,
    attackCooldown: 0,
    focusUnitId,
    path: [],
    node: 0,
    spawnTick,
  };
}

// --- Dice (req §6.1, §6.2) ---
// Stats are dice expressions now. Attack and defense are each a *list* of dice
// groups (base stat plus any equipped sword/shield), summed together on a roll —
// a list lets us combine e.g. a captain's 2D8+5 base with a sword's 1D6 without
// flattening the differing die sizes.

// Roll one dice group: `count` dice of `sides` plus the flat bonus. A group with
// count 0 (or sides 0) contributes only its bonus.
function rollDie(rngState: number, d: Dice): [nextState: number, total: number] {
  let state = rngState;
  let total = d.bonus;
  for (let i = 0; i < d.count && d.sides > 0; i++) {
    const [next, roll] = rngInt(state, 1, d.sides);
    state = next;
    total += roll;
  }
  return [state, total];
}

// Roll a list of dice groups and sum the results.
export function rollDice(
  rngState: number,
  dice: Dice[],
): [nextState: number, total: number] {
  let state = rngState;
  let total = 0;
  for (const d of dice) {
    const [next, sub] = rollDie(state, d);
    state = next;
    total += sub;
  }
  return [state, total];
}

// Min/max a dice list can produce (for HUD display only). Per group: min is
// `count·1 + bonus` clamped at 0, max is `count·sides + bonus`.
export function diceRange(dice: Dice[]): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const d of dice) {
    min += d.count + d.bonus;
    max += d.count * d.sides + d.bonus;
  }
  return { min: Math.max(0, min), max: Math.max(0, max) };
}

// --- Stat lookups (base table + equipment, req §6.1, §6.4) ---

export function unitAttackRange(u: Unit): Dice[] {
  const dice = [UNIT_ATTACK[u.kind]];
  if (u.equipped.sword) dice.push(SWORD_ATTACK_DICE);
  return dice;
}

export function unitDefense(u: Unit): Dice[] {
  const dice = [UNIT_DEFENSE[u.kind]];
  if (u.equipped.shield) dice.push(SHIELD_DEFENSE_DICE);
  return dice;
}

export function enemyAttackRange(e: Enemy): Dice[] {
  return [ENEMY_STATS[e.kind].attack];
}

export function enemyDefense(e: Enemy): Dice[] {
  return [ENEMY_STATS[e.kind].defense];
}

// Roll one hit: the attacker's attack dice less the defender's rolled defense
// dice, never below 0 (req §17.1). Returns the advanced rng state and the
// damage.
export function rollDamage(
  rngState: number,
  attack: Dice[],
  defense: Dice[],
): [nextState: number, damage: number] {
  const [afterAtk, atk] = rollDice(rngState, attack);
  const [afterDef, def] = rollDice(afterAtk, defense);
  return [afterDef, Math.max(0, atk - def)];
}

// Apply damage to a unit, horse-buffer first (req §9): the horse soaks up to its
// remaining HP, the unit takes the overflow, and the horse dies once its buffer
// is gone. Mutates and returns the unit copy.
export function applyDamageToUnit(u: Unit, dmg: number): Unit {
  let horseHp = u.horseHp;
  let remaining = dmg;
  if (horseHp > 0) {
    const absorbed = Math.min(horseHp, remaining);
    horseHp -= absorbed;
    remaining -= absorbed;
  }
  const hp = u.hp - remaining;
  return { ...u, horseHp, hp };
}

function adjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return hexDistance({ x: Math.round(ax), y: Math.round(ay) }, { x: bx, y: by }) <= 1;
}

// Minimal context the combat/AI passes need (a structural subset of SimCtx, so
// update() can pass its SimCtx straight through). Kept local so combat.ts doesn't
// import actions.ts (which would create an import cycle).
export interface CombatCtx {
  map: GameMap;
  buildings: Record<number, Building>;
  enemies: Record<number, Enemy>;
  rngState: number;
  // Ground items dropped by killed enemies (req §6.2); the resolver appends loot
  // that doesn't fit the killer's cart. `nextId` allocates their entity ids.
  groundItems: Record<number, GroundItem>;
  nextId: number;
  // Damage toasts produced this step; the resolver appends, update() reads
  // them back onto the new state for the renderer.
  damageEvents: DamageEvent[];
}

// --- Loot (req §6.2) ---

// Roll one weighted loot outcome for a dead enemy. Returns the advanced rng
// state and the bundle of resource stacks dropped (possibly empty).
function rollLoot(
  rngState: number,
  kind: EnemyKind,
): [nextState: number, drops: { resource: ResourceType; qty: number }[]] {
  const table = LOOT[kind];
  let total = 0;
  for (const o of table) total += o.weight;
  const [next, roll] = rngInt(rngState, 1, total);
  let acc = 0;
  for (const o of table) {
    acc += o.weight;
    if (roll <= acc) return [next, o.drops];
  }
  return [next, table[table.length - 1].drops];
}

// Drop a dead enemy's loot (req §6.2). Land loot lands on the enemy's tile, water
// loot on the killer's tile (the enemy is unreachable in the water). The killer
// pockets what fits its carry cap; the overflow becomes ground items for any unit
// to walk over and collect later. Returns the killer's updated inventory.
function dropLoot(
  ctx: CombatCtx,
  enemy: Enemy,
  killer: Unit,
): Inventory {
  let drops: { resource: ResourceType; qty: number }[];
  [ctx.rngState, drops] = rollLoot(ctx.rngState, enemy.kind);
  if (drops.length === 0) return killer.carrying;

  const water = isWaterEnemy(enemy.kind);
  const carrying: Inventory = { ...killer.carrying };
  const cap = carryCap(killer);
  // The tile loose loot falls on: the attacker's for water enemies, the enemy's
  // own tile for land enemies.
  const dx = water ? Math.round(killer.x) : Math.round(enemy.x);
  const dy = water ? Math.round(killer.y) : Math.round(enemy.y);

  for (const d of drops) {
    let remaining = d.qty;
    // Water loot is never auto-pocketed (req §6.2: it surfaces on the attacker's
    // tile); land loot fills the killer's cart first, then spills to the ground.
    // A captain only pockets gold/diamond (§6.1); the rest drops for a worker.
    if (!water && canCarryResource(killer, d.resource)) {
      const room = Math.max(0, cap - carriedTotal(carrying));
      const taken = Math.min(room, remaining);
      if (taken > 0) {
        carrying[d.resource] = (carrying[d.resource] ?? 0) + taken;
        remaining -= taken;
      }
    }
    if (remaining > 0) {
      const id = ctx.nextId++;
      ctx.groundItems[id] = { id, x: dx, y: dy, resource: d.resource, qty: remaining };
    }
  }
  return carrying;
}

// --- Enemy AI: movement & targeting (req §14, §17.3) ---
// Runs before the combat pass each step. Land goblins close on their target (the
// focused miner, else the nearest unit, else the nearest building) over land;
// water predators hunt the nearest reachable unit, pathing through water to a
// water tile beside it. The actual hits are applied by stepCombat, so all
// fighting still flows through the one resolver.

const ENEMY_TILES_PER_TICK = ENEMY_MOVE_TILES_PER_SEC / TICKS_PER_SECOND;

interface GoblinTarget {
  x: number;
  y: number;
}

function chooseGoblinTarget(
  e: Enemy,
  units: Record<number, Unit>,
  buildings: Record<number, Building>,
): GoblinTarget | null {
  // 1) Focused unit first (a mine goblin sticks to the miner; req §13.2).
  if (e.focusUnitId !== null) {
    const fu = units[e.focusUnitId];
    if (fu && fu.insideBuildingId === null) return { x: Math.round(fu.x), y: Math.round(fu.y) };
  }
  // 2) Nearest exposed unit.
  let bestU: Unit | null = null;
  let bestUD = Infinity;
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.insideBuildingId !== null) continue; // hidden inside a building
    const d = hexDistance({ x: Math.round(e.x), y: Math.round(e.y) }, { x: Math.round(u.x), y: Math.round(u.y) });
    if (d < bestUD) { bestUD = d; bestU = u; }
  }
  if (bestU) return { x: Math.round(bestU.x), y: Math.round(bestU.y) };
  // 3) Otherwise march on the nearest building (req §17.3).
  let bestB: Building | null = null;
  let bestBD = Infinity;
  for (const key of Object.keys(buildings)) {
    const b = buildings[Number(key)];
    const d = hexDistance({ x: Math.round(e.x), y: Math.round(e.y) }, { x: b.x, y: b.y });
    if (d < bestBD) { bestBD = d; bestB = b; }
  }
  return bestB ? { x: bestB.x, y: bestB.y } : null;
}

// A water predator's target: the nearest exposed unit that has at least one
// water tile beside it (so the predator has somewhere to strike from). Units with
// no water neighbour are unreachable and skipped; pathing later confirms the
// reachable ones. Buildings are never targeted — predators only hit units.
function chooseWaterTarget(
  map: GameMap,
  e: Enemy,
  units: Record<number, Unit>,
): GoblinTarget | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.insideBuildingId !== null) continue; // hidden inside a building
    const ux = Math.round(u.x);
    const uy = Math.round(u.y);
    const nearWater = hexNeighbors(ux, uy).some(
      (n) => inBounds(map, n.x, n.y) && tileAt(map, n.x, n.y) === "water",
    );
    if (!nearWater) continue;
    const d = hexDistance({ x: Math.round(e.x), y: Math.round(e.y) }, { x: ux, y: uy });
    if (d < bestD) { bestD = d; best = u; }
  }
  return best ? { x: Math.round(best.x), y: Math.round(best.y) } : null;
}

// Walk along `path` from (x,y) consuming up to `budget` tiles of distance.
function stepEnemyAlong(
  x: number,
  y: number,
  path: TileCoord[],
  node: number,
  budget: number,
): { x: number; y: number; node: number } {
  while (budget > 0 && node < path.length) {
    const t = path[node];
    const dx = t.x - x;
    const dy = t.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) { node++; continue; }
    if (dist <= budget) {
      x = t.x; y = t.y; node++; budget -= dist;
    } else {
      x += (dx / dist) * budget;
      y += (dy / dist) * budget;
      budget = 0;
    }
  }
  return { x, y, node };
}

export function stepEnemyAI(
  ctx: CombatCtx,
  units: Record<number, Unit>,
  dtTicks: number,
): void {
  const enemies = ctx.enemies;
  const W = ctx.map.width;
  // Track the tile each enemy occupies so two never settle on the same hex
  //. Keyed by row-major tile index; kept in sync as enemies move.
  const occupied = new Map<number, number>();
  const tileIdx = (x: number, y: number): number => Math.round(y) * W + Math.round(x);
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    occupied.set(tileIdx(e.x, e.y), e.id);
  }
  const tileFree = (x: number, y: number, selfId: number): boolean => {
    const o = occupied.get(tileIdx(x, y));
    return o === undefined || o === selfId;
  };
  const reoccupy = (e: Enemy, nx: number, ny: number): void => {
    const oldK = tileIdx(e.x, e.y);
    if (occupied.get(oldK) === e.id) occupied.delete(oldK);
    occupied.set(tileIdx(nx, ny), e.id);
  };

  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    const water = isWaterEnemy(e.kind);

    // The tile to close on. Land goblins march on the focused miner / nearest
    // unit / nearest building; water predators hunt the nearest reachable unit.
    const target = water
      ? chooseWaterTarget(ctx.map, e, units)
      : chooseGoblinTarget(e, units, ctx.buildings);
    if (!target) {
      if (e.path.length) enemies[e.id] = { ...e, path: [], node: 0 };
      continue;
    }

    // A tile this enemy may stand on to fight from: land enemies need a walkable
    // hex, water predators a water hex (req §14).
    const standable = (x: number, y: number): boolean =>
      water
        ? inBounds(ctx.map, x, y) && tileAt(ctx.map, x, y) === "water"
        : isWalkable(ctx.map, x, y, ctx.buildings);

    // Reserve a distinct free hex adjacent to the target to fight from: the
    // current tile if it already abuts the target and isn't taken, otherwise the
    // nearest free standable neighbour of the target.
    const cur = { x: Math.round(e.x), y: Math.round(e.y) };
    let stop: TileCoord | null = null;
    if (hexDistance(cur, target) <= 1 && tileFree(cur.x, cur.y, e.id)) {
      stop = cur;
    } else {
      const cands = hexNeighbors(target.x, target.y)
        .filter((n) => standable(n.x, n.y) && tileFree(n.x, n.y, e.id))
        .sort(
          (a, b) =>
            (a.x - e.x) ** 2 + (a.y - e.y) ** 2 -
            ((b.x - e.x) ** 2 + (b.y - e.y) ** 2),
        );
      stop = cands[0] ?? null;
    }
    if (!stop) {
      // No free tile to stand on near the target — hold position this step.
      if (e.path.length) enemies[e.id] = { ...e, path: [], node: 0 };
      continue;
    }

    // Already on the reserved tile: settle on its centre and hold.
    if (cur.x === stop.x && cur.y === stop.y) {
      if (e.x !== stop.x || e.y !== stop.y || e.path.length) {
        enemies[e.id] = { ...e, x: stop.x, y: stop.y, path: [], node: 0 };
      }
      continue;
    }

    // (Re)path toward the reserved tile when our route is spent or aimed at a
    // different tile (the target — and thus the reserved hex — may have moved).
    // Land enemies path over walkable terrain; water predators over water only.
    let path = e.path;
    let node = e.node;
    const last = path.length > 0 ? path[path.length - 1] : null;
    const stillGood = last !== null && last.x === stop.x && last.y === stop.y;
    if (node >= path.length || !stillGood) {
      const np = water
        ? findWaterPath(ctx.map, cur, stop)
        : findPath(ctx.map, cur, stop, ctx.buildings);
      if (!np || np.length === 0) {
        if (e.path.length) enemies[e.id] = { ...e, path: [], node: 0 };
        continue;
      }
      path = np;
      node = 0;
    }
    const r = stepEnemyAlong(e.x, e.y, path, node, ENEMY_TILES_PER_TICK * dtTicks);
    if (hexDistance({ x: Math.round(r.x), y: Math.round(r.y) }, target) <= 1) {
      // Arrived adjacent this step: settle on the tile centre to fight.
      reoccupy(e, Math.round(r.x), Math.round(r.y));
      enemies[e.id] = { ...e, x: Math.round(r.x), y: Math.round(r.y), path: [], node: 0 };
    } else {
      reoccupy(e, r.x, r.y);
      enemies[e.id] = { ...e, x: r.x, y: r.y, path, node: r.node };
    }
  }
}

// The §17.1 resolver, run as one update() pass after enemy movement. Decrements
// every combatant's cooldown; then every unit hex-adjacent to an enemy swings on
// cooldown (idle soldiers/captains auto-attack and workers defend in place — the
// "don't chase" rule is honored by never *moving* a unit toward an enemy except
// under an explicit attack order), and every enemy adjacent to a valid target
// swings back. Land enemies hit the nearest adjacent unit, or batter an adjacent
// building when no unit is in reach; water predators strike any adjacent unit
//. Entities at 0 HP are removed; a destroyed
// building frees its occupant, and `onUnitDeath` lets the caller release any
// building slot a slain unit held.
export function stepCombat(
  ctx: CombatCtx,
  units: Record<number, Unit>,
  dtTicks: number,
  onUnitDeath: (u: Unit) => void,
): void {
  const enemies = ctx.enemies;

  // 1) Tick cooldowns down (stable iteration over current ids).
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.attackCooldown > 0) units[u.id] = { ...u, attackCooldown: Math.max(0, u.attackCooldown - dtTicks) };
  }
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    if (e.attackCooldown > 0) enemies[e.id] = { ...e, attackCooldown: Math.max(0, e.attackCooldown - dtTicks) };
  }

  // 2) Units attack adjacent enemies. A unit picks the nearest adjacent enemy;
  //    an explicit attack order is honored when its target is adjacent.
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.insideBuildingId !== null) continue; // hidden inside a building
    if (u.attackCooldown > 0) continue;
    const target = chooseEnemyTarget(u, enemies);
    if (!target) continue;
    const [next, dmg] = rollDamage(ctx.rngState, unitAttackRange(u), enemyDefense(target));
    ctx.rngState = next;
    if (dmg > 0) ctx.damageEvents.push({ x: target.x, y: target.y, amount: dmg, target: "enemy" });
    const hp = target.hp - dmg;
    let carrying = u.carrying;
    if (hp <= 0) {
      carrying = dropLoot(ctx, target, u); // req §6.2: killer loots what fits
      delete enemies[target.id];
    } else {
      enemies[target.id] = { ...target, hp };
    }
    units[u.id] = { ...u, carrying, attackCooldown: ATTACK_INTERVAL_TICKS };
  }

  // 3) Enemies strike back.
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    if (e.attackCooldown > 0) continue;
    if (isWaterEnemy(e.kind)) {
      // A water predator strikes any unit standing on an adjacent shore tile,
      // not just one that is actively fishing.
      const target = chooseUnitTarget(e, units);
      if (!target) continue;
      strikeUnit(ctx, e, target, units, onUnitDeath);
    } else {
      // Land goblin: nearest adjacent unit, else an adjacent building.
      const unitTarget = chooseUnitTarget(e, units);
      if (unitTarget) {
        strikeUnit(ctx, e, unitTarget, units, onUnitDeath);
      } else {
        const b = chooseBuildingTarget(e, ctx.buildings);
        if (b) strikeBuilding(ctx, e, b, units);
      }
    }
  }
}

// Apply one enemy hit to a unit, removing it (and releasing its slot) if it dies.
function strikeUnit(
  ctx: CombatCtx,
  e: Enemy,
  target: Unit,
  units: Record<number, Unit>,
  onUnitDeath: (u: Unit) => void,
): void {
  const [next, dmg] = rollDamage(ctx.rngState, enemyAttackRange(e), unitDefense(target));
  ctx.rngState = next;
  if (dmg > 0) ctx.damageEvents.push({ x: target.x, y: target.y, amount: dmg, target: "unit" });
  const hit = applyDamageToUnit(target, dmg);
  if (hit.hp <= 0) {
    onUnitDeath(hit);
    delete units[target.id];
  } else {
    units[target.id] = hit;
  }
  ctx.enemies[e.id] = { ...e, attackCooldown: ATTACK_INTERVAL_TICKS };
}

// Apply one enemy hit to a building (no defense stat — raw damage). A razed
// building is removed and any occupant is ejected to idle (req §16.1, §17.3).
function strikeBuilding(
  ctx: CombatCtx,
  e: Enemy,
  b: Building,
  units: Record<number, Unit>,
): void {
  const [next, dmg] = rollDamage(ctx.rngState, enemyAttackRange(e), []);
  ctx.rngState = next;
  const hp = b.hp - dmg;
  if (hp <= 0) {
    if (b.occupantId !== null) {
      const occ = units[b.occupantId];
      if (occ) units[occ.id] = { ...occ, insideBuildingId: null, order: { type: "idle" } };
    }
    delete ctx.buildings[b.id];
  } else {
    ctx.buildings[b.id] = { ...b, hp };
  }
  ctx.enemies[e.id] = { ...e, attackCooldown: ATTACK_INTERVAL_TICKS };
}

// Prefer the unit's explicit attack target if adjacent; otherwise the nearest
// adjacent enemy (so idle units auto-defend). Returns null when none is adjacent.
function chooseEnemyTarget(u: Unit, enemies: Record<number, Enemy>): Enemy | null {
  if (u.order.type === "attack") {
    const t = enemies[u.order.targetId];
    if (t && adjacent(u.x, u.y, t.x, t.y)) return t;
  }
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    if (!adjacent(u.x, u.y, e.x, e.y)) continue;
    const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function chooseUnitTarget(e: Enemy, units: Record<number, Unit>): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const key of Object.keys(units)) {
    const u = units[Number(key)];
    if (u.insideBuildingId !== null) continue;
    if (!adjacent(u.x, u.y, e.x, e.y)) continue;
    const d = (u.x - e.x) ** 2 + (u.y - e.y) ** 2;
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}

function chooseBuildingTarget(e: Enemy, buildings: Record<number, Building>): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const key of Object.keys(buildings)) {
    const b = buildings[Number(key)];
    if (!adjacent(e.x, e.y, b.x, b.y)) continue;
    const d = (b.x - e.x) ** 2 + (b.y - e.y) ** 2;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}
