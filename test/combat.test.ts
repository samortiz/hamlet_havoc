// M5 — Combat (req §6.1, §6.4, §9, §17). Headless sim tests for the damage
// formula, equipment/horse effects on stats and damage absorption, auto-attack,
// the attack order's close-and-fight loop, and the once-per-second cadence.
// Enemies are stationary and injected directly (spawning/AI is M6, req §27).

import { describe, expect, it } from "vitest";
import {
  ATTACK_INTERVAL_TICKS,
  SHIELD_DEFENSE_BONUS,
  SWORD_ATTACK_BONUS,
  UNIT_ATTACK,
  UNIT_DEFENSE,
} from "../src/config/index.js";
import {
  applyDamageToUnit,
  makeEnemy,
  rollDamage,
  unitAttackRange,
  unitDefense,
  type EnemyKind,
} from "../src/game/combat.js";
import { hexNeighbors } from "../src/game/hex.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";
import type { Unit, UnitKind } from "../src/game/units.js";

function advance(s: GameState, ticks: number): GameState {
  for (let i = 0; i < ticks; i++) s = update(s, [], 1);
  return s;
}
function firstUnitId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}
function setUnit(s: GameState, id: number, patch: Partial<Unit>): GameState {
  return { ...s, units: { ...s.units, [id]: { ...s.units[id], ...patch } } };
}
function setKind(s: GameState, id: number, kind: UnitKind): GameState {
  return setUnit(s, id, { kind });
}
function addEnemy(s: GameState, kind: EnemyKind, x: number, y: number): { s: GameState; id: number } {
  const id = s.nextEntityId;
  const enemies = { ...s.enemies, [id]: makeEnemy(id, kind, x, y) };
  return { s: { ...s, nextEntityId: id + 1, enemies }, id };
}

describe("damage formula (req §17.1)", () => {
  it("rolls within range, subtracts defense, and never goes negative", () => {
    // Range 1-3 vs defense 1 → results in {0,1,2}; never < 0.
    let rng = 12345;
    let sawZero = false;
    let max = 0;
    for (let i = 0; i < 500; i++) {
      let dmg: number;
      [rng, dmg] = rollDamage(rng, { min: 1, max: 3 }, 1);
      expect(dmg).toBeGreaterThanOrEqual(0);
      expect(dmg).toBeLessThanOrEqual(2);
      if (dmg === 0) sawZero = true;
      if (dmg > max) max = dmg;
    }
    expect(sawZero).toBe(true); // a roll of 1 (− def 1) clamps to 0
    expect(max).toBe(2);
  });

  it("a high defense clamps every hit to 0", () => {
    let rng = 7;
    for (let i = 0; i < 100; i++) {
      let dmg: number;
      [rng, dmg] = rollDamage(rng, { min: 0, max: 3 }, 10);
      expect(dmg).toBe(0);
    }
  });
});

describe("equipment effects on stats (req §6.4)", () => {
  it("a sword raises the attack range and a shield raises defense", () => {
    const base = createInitialState(1);
    const id = firstUnitId(base);
    const plain = base.units[id];
    expect(unitAttackRange(plain)).toEqual(UNIT_ATTACK.worker);
    expect(unitDefense(plain)).toBe(UNIT_DEFENSE.worker);

    const armed = { ...plain, equipped: { sword: true, shield: true } };
    expect(unitAttackRange(armed)).toEqual({
      min: UNIT_ATTACK.worker.min + SWORD_ATTACK_BONUS,
      max: UNIT_ATTACK.worker.max + SWORD_ATTACK_BONUS,
    });
    expect(unitDefense(armed)).toBe(UNIT_DEFENSE.worker + SHIELD_DEFENSE_BONUS);
  });
});

describe("horse damage absorption (req §9)", () => {
  it("a horse soaks the first 3 HP, then dies and overflow hits the unit", () => {
    const base = createInitialState(1);
    const id = firstUnitId(base);
    const mounted: Unit = { ...base.units[id], hp: 2, horseHp: 3 };

    const afterTwo = applyDamageToUnit(mounted, 2);
    expect(afterTwo.horseHp).toBe(1); // horse soaked 2
    expect(afterTwo.hp).toBe(2); // unit untouched

    const afterOverflow = applyDamageToUnit(afterTwo, 2);
    expect(afterOverflow.horseHp).toBe(0); // horse dies (buffer gone)
    expect(afterOverflow.hp).toBe(1); // 1 overflow reached the unit
  });
});

describe("combat resolution through update() (req §17)", () => {
  it("a captain kills an adjacent goblin and survives", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 6 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    const added = addEnemy(s, "goblin", n.x, n.y);
    s = added.s;

    s = advance(s, 120); // ≤4 sec; captain deals ≥1/swing → goblin (3 HP) dies
    expect(s.enemies[added.id]).toBeUndefined();
    expect(s.units[id]).toBeDefined();
    expect(s.units[id].hp).toBeGreaterThan(0);
  });

  it("an idle soldier auto-attacks an adjacent enemy with no order given", () => {
    let s = createInitialState(99);
    const id = firstUnitId(s);
    s = setKind(s, id, "soldier");
    // Ample HP so the test isolates the auto-attack behaviour from the damage
    // race (a 4-HP soldier vs a 0-3/swing goblin is seed-dependent); the soldier
    // deals ≥1/swing, so over 150 ticks the 3-HP goblin always dies.
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 99, order: { type: "idle" } });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    const added = addEnemy(s, "goblin", n.x, n.y);
    s = added.s;

    s = advance(s, 150);
    expect(s.enemies[added.id]).toBeUndefined(); // killed without a command
  });

  it("a lone worker is killed by an adjacent kraken", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 2 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = addEnemy(s, "kraken", n.x, n.y).s;

    s = advance(s, 120); // kraken deals ≥1/swing → worker (2 HP) dies
    expect(s.units[id]).toBeUndefined();
  });

  it("an attack order walks the unit to the enemy and then engages", () => {
    let s = createInitialState(7);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 6 });
    // A goblin three tiles east — inside the starting grass clearing.
    const ex = HAMLET_CENTER.x + 3;
    const ey = HAMLET_CENTER.y;
    const added = addEnemy(s, "goblin", ex, ey);
    s = added.s;

    s = update(s, [{ type: "attack", unitIds: [id], targetEnemyId: added.id }], 1);
    expect(s.units[id].order.type).toBe("attack");
    s = advance(s, 250); // walk ~3 tiles, then fight
    expect(s.enemies[added.id]).toBeUndefined();
  });

  it("attacks fire once per second, not every tick (cooldown)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 6 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = addEnemy(s, "kraken", n.x, n.y).s; // 5 HP — survives a swing or two

    s = advance(s, 1); // one tick: exactly one swing, cooldown set
    expect(s.units[id].attackCooldown).toBe(ATTACK_INTERVAL_TICKS);
    const cdAfter = s.units[id].attackCooldown;
    s = advance(s, 1); // next tick: no new swing, cooldown ticks down
    expect(s.units[id].attackCooldown).toBe(cdAfter - 1);
  });
});
