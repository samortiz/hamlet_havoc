// Combat (req §6.1, §6.4, §9, §17). Headless sim tests for the damage
// formula, equipment/horse effects on stats and damage absorption, auto-attack,
// the attack order's close-and-fight loop, and the once-per-second cadence.
// Enemies are stationary and injected directly (spawning/AI is covered in enemy.test.ts).

import { describe, expect, it } from "vitest";
import {
  ATTACK_INTERVAL_TICKS,
  MAP_WIDTH,
  SHIELD_DEFENSE_DICE,
  SWORD_ATTACK_DICE,
  TICKS_PER_SEASON,
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
import { deserialize, serialize } from "../src/game/persistence.js";
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
  it("rolls attack dice, subtracts rolled defense, and never goes negative", () => {
    // 1D3 attack (1-3) vs a flat-1 defense → results in {0,1,2}; never < 0.
    const attack = [{ count: 1, sides: 3, bonus: 0 }];
    const defense = [{ count: 0, sides: 0, bonus: 1 }];
    let rng = 12345;
    let sawZero = false;
    let max = 0;
    for (let i = 0; i < 500; i++) {
      let dmg: number;
      [rng, dmg] = rollDamage(rng, attack, defense);
      expect(dmg).toBeGreaterThanOrEqual(0);
      expect(dmg).toBeLessThanOrEqual(2);
      if (dmg === 0) sawZero = true;
      if (dmg > max) max = dmg;
    }
    expect(sawZero).toBe(true); // a roll of 1 (− def 1) clamps to 0
    expect(max).toBe(2);
  });

  it("a high defense clamps every hit to 0", () => {
    const attack = [{ count: 1, sides: 4, bonus: -1 }]; // 0-3
    const defense = [{ count: 0, sides: 0, bonus: 10 }];
    let rng = 7;
    for (let i = 0; i < 100; i++) {
      let dmg: number;
      [rng, dmg] = rollDamage(rng, attack, defense);
      expect(dmg).toBe(0);
    }
  });

  it("sums a multi-die defense roll against the attack roll", () => {
    // 2D8+5 attack vs 1D4+1 defense (captain stats). Damage is non-negative and
    // bounded by [maxAtk − minDef, ...]; over many rolls it spans a wide range.
    const attack = [UNIT_ATTACK.captain];
    const defense = [UNIT_DEFENSE.captain];
    let rng = 99;
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < 1000; i++) {
      let dmg: number;
      [rng, dmg] = rollDamage(rng, attack, defense);
      expect(dmg).toBeGreaterThanOrEqual(0);
      min = Math.min(min, dmg);
      max = Math.max(max, dmg);
    }
    // atk ∈ [7,21], def ∈ [2,5] → dmg ∈ [2,19].
    expect(min).toBeGreaterThanOrEqual(2);
    expect(max).toBeLessThanOrEqual(19);
  });
});

describe("equipment effects on stats (req §6.4)", () => {
  it("a sword adds an attack die and a shield adds a defense die", () => {
    const base = createInitialState(1);
    const id = firstUnitId(base);
    const plain = base.units[id];
    expect(unitAttackRange(plain)).toEqual([UNIT_ATTACK.worker]);
    expect(unitDefense(plain)).toEqual([UNIT_DEFENSE.worker]);

    const armed = { ...plain, equipped: { sword: true, shield: true } };
    expect(unitAttackRange(armed)).toEqual([UNIT_ATTACK.worker, SWORD_ATTACK_DICE]);
    expect(unitDefense(armed)).toEqual([UNIT_DEFENSE.worker, SHIELD_DEFENSE_DICE]);
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

  it("a lone worker is killed by an adjacent goblin", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 2 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = addEnemy(s, "goblin", n.x, n.y).s;

    s = advance(s, 120); // goblin deals up to 3/swing → worker (2 HP) dies
    expect(s.units[id]).toBeUndefined();
  });

  it("a soldier pockets the loot from a goblin it kills (req §6.2)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "soldier");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 99, carrying: {} });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    const added = addEnemy(s, "goblin", n.x, n.y);
    s = added.s;

    s = advance(s, 120);
    expect(s.enemies[added.id]).toBeUndefined();
    // Goblin loot is iron or gold; with carry room the killer holds it and no
    // loot is left lying around.
    const carried = (s.units[id].carrying.iron ?? 0) + (s.units[id].carrying.gold ?? 0);
    expect(carried).toBeGreaterThan(0);
    expect(Object.keys(s.groundItems)).toHaveLength(0);
  });

  it("loot the killer can't hold drops to the ground for a passer-by (req §6.2)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    // A soldier whose cart is already full has no room for loot — it all hits
    // the ground (carry cap 5, filled with wood here).
    s = setKind(s, id, "soldier");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 99, carrying: { wood: 5 } });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    const added = addEnemy(s, "goblin", n.x, n.y);
    s = added.s;

    s = advance(s, 120);
    expect(s.enemies[added.id]).toBeUndefined();
    const items = Object.values(s.groundItems);
    expect(items.length).toBeGreaterThan(0);
    // Loose loot from a land enemy sits on the enemy's own tile.
    expect(items[0].x).toBe(n.x);
    expect(items[0].y).toBe(n.y);

    // A worker standing on that tile collects it next step.
    const wid = Number(Object.keys(s.units).find((k) => s.units[Number(k)].kind === "worker"));
    s = setUnit(s, wid, { x: n.x, y: n.y, order: { type: "idle" }, carrying: {} });
    s = advance(s, 1);
    expect(Object.keys(s.groundItems)).toHaveLength(0);
    const collected = (s.units[wid].carrying.iron ?? 0) + (s.units[wid].carrying.gold ?? 0);
    expect(collected).toBeGreaterThan(0);
  });

  it("a captain pockets gold/diamond loot but leaves other resources behind (req §6.1)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 99, carrying: {} });
    // Drop one gold and one iron stack on the captain's tile.
    const gx = HAMLET_CENTER.x;
    const gy = HAMLET_CENTER.y;
    const g1 = s.nextEntityId;
    const g2 = g1 + 1;
    s = {
      ...s,
      nextEntityId: g2 + 1,
      groundItems: {
        [g1]: { id: g1, x: gx, y: gy, resource: "gold", qty: 2 },
        [g2]: { id: g2, x: gx, y: gy, resource: "iron", qty: 2 },
      },
    };
    s = advance(s, 1);
    // Captain keeps the gold, ignores the iron — which stays on the ground.
    expect(s.units[id].carrying.gold).toBe(2);
    expect(s.units[id].carrying.iron ?? 0).toBe(0);
    const left = Object.values(s.groundItems);
    expect(left).toHaveLength(1);
    expect(left[0].resource).toBe("iron");
  });

  it("a unit closing on an attack order stops on a tile centre", () => {
    let s = createInitialState(7);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 99 });
    // A kraken (never moves) three tiles east — the captain must walk over. Give
    // it ample HP so it outlives the close-in, keeping the focus on movement (the
    // captain's 2D8+5 would otherwise one-shot it before it settles on a centre).
    const added = addEnemy(s, "kraken", HAMLET_CENTER.x + 3, HAMLET_CENTER.y);
    s = added.s;
    s = { ...s, enemies: { ...s.enemies, [added.id]: { ...s.enemies[added.id], hp: 999 } } };

    s = update(s, [{ type: "attack", unitIds: [id], targetEnemyId: added.id }], 1);
    // Step until the captain stops advancing (it has reached the enemy and holds).
    let prev = { x: -1, y: -1 };
    for (let i = 0; i < 200; i++) {
      s = update(s, [], 1);
      const u = s.units[id];
      if (u.x === prev.x && u.y === prev.y && u.order.type === "attack") break;
      prev = { x: u.x, y: u.y };
    }
    const u = s.units[id];
    expect(u.order.type).toBe("attack");
    // It engaged from an adjacent hex centre, not a fractional mid-tile position.
    expect(Number.isInteger(u.x)).toBe(true);
    expect(Number.isInteger(u.y)).toBe(true);
    expect(hexNeighbors(HAMLET_CENTER.x + 3, HAMLET_CENTER.y).some((n) => n.x === u.x && n.y === u.y)).toBe(true);
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

  it("emits a per-step damage event when a hit lands, for the renderer toast", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 6 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    const added = addEnemy(s, "kraken", n.x, n.y); // 5 HP, water enemy holds still
    s = added.s;

    // First tick: the captain swings; a hit that deals >0 damage records an
    // enemy-target event at the kraken's tile. (A 0-roll is possible but the
    // captain's range guarantees damage here over the first swing.)
    s = update(s, [], 1);
    const enemyHits = s.damageEvents.filter((d) => d.target === "enemy");
    expect(enemyHits.length).toBeGreaterThanOrEqual(1);
    expect(enemyHits[0].amount).toBeGreaterThan(0);
    expect(enemyHits[0].x).toBe(n.x);
    expect(enemyHits[0].y).toBe(n.y);

    // The list is per-step: a quiet tick (cooldown still ticking) carries none.
    s = update(s, [], 1);
    expect(s.damageEvents.length).toBe(0);
  });

  it("strips damageEvents from saves so they don't replay on load", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "captain");
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 6 });
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = addEnemy(s, "kraken", n.x, n.y).s;
    s = update(s, [], 1);
    expect(s.damageEvents.length).toBeGreaterThan(0); // a hit landed this step
    const restored = deserialize(serialize(s));
    expect(restored.damageEvents).toEqual([]); // transient, not persisted
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

// A long eastward move path (clamped to the map) that keeps a unit travelling for
// the whole test window, so it never falls idle.
function eastwardPath(x: number, y: number, len: number): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  for (let i = 1; i <= len; i++) path.push({ x: Math.min(MAP_WIDTH - 1, x + i), y });
  return path;
}

describe("healing (req §6.2)", () => {
  it("an idle wounded unit regenerates 5% max HP every 5 sec with a +N toast", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { hp: 2, order: { type: "idle" } }); // worker, maxHp 10
    s = advance(s, 149); // just shy of the first 5-sec heal boundary
    expect(s.units[id].hp).toBe(2); // no heal yet
    s = update(s, [], 1); // crosses tick 150 = one heal interval
    expect(s.units[id].hp).toBe(3); // +ceil(10 * 0.05) = 1
    expect(s.healEvents.some((h) => h.amount === 1)).toBe(true);
  });

  it("a season change heals every wounded unit, idle or not", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setKind(s, id, "soldier"); // maxHp 20
    // Stock meat so the season-end upkeep doesn't demote the soldier (which would
    // reset its HP and mask the heal), and start just before a season boundary.
    s = { ...s, resources: { ...s.resources, meat: 100 }, tickCount: TICKS_PER_SEASON - 1 };
    const u = s.units[id];
    // Mid-move so it is *not* idle when the season turns: proves the season heal
    // ignores the idle rule.
    const path = eastwardPath(Math.round(u.x), Math.round(u.y), 10);
    s = setUnit(s, id, { hp: 1, order: { type: "move", path, node: 0 } });
    s = update(s, [], 1); // crosses the season boundary
    expect(s.units[id].order.type).toBe("move"); // still travelling, never idle
    expect(s.units[id].hp).toBe(6); // +ceil(20 * 0.25) = 5; no idle regen
    expect(s.healEvents.some((h) => h.amount === 5)).toBe(true);
  });

  it("a non-idle unit does not regenerate HP", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const u = s.units[id];
    const path = eastwardPath(Math.round(u.x), Math.round(u.y), 30);
    s = setUnit(s, id, { hp: 2, order: { type: "move", path, node: 0 } });
    s = advance(s, 150); // a full heal interval, but the unit is moving throughout
    expect(s.units[id].order.type).toBe("move");
    expect(s.units[id].hp).toBe(2); // never idle → no regen
  });

  it("strips healEvents from saves so they don't replay on load", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { hp: 2, order: { type: "idle" } });
    s = advance(s, 150); // a heal fires this window
    const restored = deserialize(serialize(s));
    expect(restored.healEvents).toEqual([]); // transient, not persisted
  });
});
