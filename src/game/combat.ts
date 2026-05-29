// Combat (req §17). One resolver handles all fighting — year-end attacks, mine
// goblins, and serpent/kraken fishing attacks all flow through `stepCombat`.
// Adjacent opposing entities trade blows once per second; each hit rolls a
// random integer in the attacker's range, subtracts the defender's defense
// (min 0), and applies the damage. A horse's buffer HP soaks damage first.
//
// Plain, id-based data like every other entity (req §2.6): enemies live in a
// `Record<number, Enemy>` on GameState. M5 ships the resolution + the player's
// attack/defend behavior with stationary, injectable enemies; enemy spawning,
// movement/targeting AI, and loot drops are M6 (req §27).

import {
  ATTACK_INTERVAL_TICKS,
  ENEMY_STATS,
  SHIELD_DEFENSE_BONUS,
  SWORD_ATTACK_BONUS,
  UNIT_ATTACK,
  UNIT_DEFENSE,
} from "../config/index.js";
import { hexDistance } from "./hex.js";
import { rngInt } from "./rng.js";
import type { Unit } from "./units.js";

export type EnemyKind = "goblin" | "seaSerpent" | "kraken";

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number; // tile (enemies don't move in M5; AI lands in M6)
  y: number;
  hp: number;
  attackCooldown: number; // ticks until next swing (req §17.1)
}

export interface DamageRange {
  min: number;
  max: number;
}

export function makeEnemy(id: number, kind: EnemyKind, x: number, y: number): Enemy {
  return { id, kind, x, y, hp: ENEMY_STATS[kind].hp, attackCooldown: 0 };
}

// --- Stat lookups (base table + equipment, req §6.1, §6.4) ---

export function unitAttackRange(u: Unit): DamageRange {
  const base = UNIT_ATTACK[u.kind];
  const bonus = u.equipped.sword ? SWORD_ATTACK_BONUS : 0;
  return { min: base.min + bonus, max: base.max + bonus };
}

export function unitDefense(u: Unit): number {
  return UNIT_DEFENSE[u.kind] + (u.equipped.shield ? SHIELD_DEFENSE_BONUS : 0);
}

export function enemyAttackRange(e: Enemy): DamageRange {
  return ENEMY_STATS[e.kind].attack;
}

export function enemyDefense(e: Enemy): number {
  return ENEMY_STATS[e.kind].defense;
}

// Roll one hit: a random integer in [min, max] less the defender's defense,
// never below 0 (req §17.1). Returns the advanced rng state and the damage.
export function rollDamage(
  rngState: number,
  range: DamageRange,
  defense: number,
): [nextState: number, damage: number] {
  const [next, roll] = rngInt(rngState, range.min, range.max);
  return [next, Math.max(0, roll - defense)];
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

// Minimal context the combat pass needs (a subset of SimCtx). Kept local so
// combat.ts doesn't import actions.ts (which imports units/buildings/etc.).
export interface CombatCtx {
  enemies: Record<number, Enemy>;
  rngState: number;
}

// The §17.1 resolver, run as one update() pass. Decrements every combatant's
// cooldown; then every unit hex-adjacent to an enemy swings on cooldown (this is
// what makes idle soldiers/captains auto-attack and workers defend in place —
// the "don't chase" rule is honored elsewhere by never *moving* a unit toward an
// enemy except under an explicit attack order), and every enemy adjacent to a
// unit swings back. Entities at 0 HP are removed; `onUnitDeath` lets the caller
// release building occupancy before the unit is dropped.
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
    const hp = target.hp - dmg;
    if (hp <= 0) delete enemies[target.id];
    else enemies[target.id] = { ...target, hp };
    units[u.id] = { ...u, attackCooldown: ATTACK_INTERVAL_TICKS };
  }

  // 3) Enemies strike back at an adjacent unit.
  for (const key of Object.keys(enemies)) {
    const e = enemies[Number(key)];
    if (e.attackCooldown > 0) continue;
    const target = chooseUnitTarget(e, units);
    if (!target) continue;
    const [next, dmg] = rollDamage(ctx.rngState, enemyAttackRange(e), unitDefense(target));
    ctx.rngState = next;
    const hit = applyDamageToUnit(target, dmg);
    if (hit.hp <= 0) {
      onUnitDeath(hit);
      delete units[target.id];
    } else {
      units[target.id] = hit;
    }
    enemies[e.id] = { ...e, attackCooldown: ATTACK_INTERVAL_TICKS };
  }
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
