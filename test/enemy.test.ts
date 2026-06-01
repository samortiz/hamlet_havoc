// Enemy AI & spawning (req §13.2, §17.3). Headless sim tests for goblin
// movement/targeting (close on the nearest unit, batter a building when no unit
// is in reach), the water-predator rules (only strike a fishing unit; leave at
// winter), driven through the real update() step.

import { describe, expect, it } from "vitest";
import { TICKS_PER_SEASON, TICKS_PER_SECOND, TICKS_PER_YEAR } from "../src/config/index.js";
import { makeEnemy, type EnemyKind } from "../src/game/combat.js";
import { hexDistance, hexNeighbors } from "../src/game/hex.js";
import { HAMLET_CENTER, inBounds, isWalkable, tileAt } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function advance(s: GameState, ticks: number): GameState {
  for (let i = 0; i < ticks; i++) s = update(s, [], 1);
  return s;
}
function firstUnitId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}
function addEnemy(
  s: GameState,
  kind: EnemyKind,
  x: number,
  y: number,
  spawnTick = 0,
): { s: GameState; id: number } {
  const id = s.nextEntityId;
  const enemies = { ...s.enemies, [id]: makeEnemy(id, kind, x, y, null, spawnTick) };
  return { s: { ...s, nextEntityId: id + 1, enemies }, id };
}
// Find a water tile and a land tile beside it (a fisher's spot) near the hamlet.
function findShore(s: GameState): { water: { x: number; y: number }; land: { x: number; y: number } } {
  let best: { water: { x: number; y: number }; land: { x: number; y: number } } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (tileAt(s.map, x, y) !== "water") continue;
      for (const n of hexNeighbors(x, y)) {
        if (!isWalkable(s.map, n.x, n.y)) continue;
        const d = (n.x - HAMLET_CENTER.x) ** 2 + (n.y - HAMLET_CENTER.y) ** 2;
        if (d < bestD) { bestD = d; best = { water: { x, y }, land: { x: n.x, y: n.y } }; }
      }
    }
  }
  if (!best) throw new Error("no shore tile");
  return best;
}
function totalBuildingHp(s: GameState): number {
  let hp = 0;
  for (const b of Object.values(s.buildings)) hp += b.hp;
  return hp;
}
// Nearest mountain with a walkable neighbour (so a worker can build the mine).
function findMountain(s: GameState): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] !== "mountain") continue;
      if (!hexNeighbors(x, y).some((n) => isWalkable(s.map, n.x, n.y))) continue;
      const d = (x - HAMLET_CENTER.x) ** 2 + (y - HAMLET_CENTER.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  if (!best) throw new Error("no reachable mountain tile");
  return best;
}

describe("goblin movement & targeting (req §17.3)", () => {
  it("marches toward the nearest unit", () => {
    let s = createInitialState(555);
    const id = firstUnitId(s);
    // Isolate one unit so the goblin's target is unambiguous.
    const unit = { ...s.units[id], x: HAMLET_CENTER.x, y: HAMLET_CENTER.y + 4, order: { type: "idle" as const } };
    s = { ...s, units: { [id]: unit } };
    const gx = HAMLET_CENTER.x;
    const gy = HAMLET_CENTER.y - 4;
    const added = addEnemy(s, "goblin", gx, gy);
    s = added.s;

    const start = hexDistance({ x: gx, y: gy }, { x: unit.x, y: unit.y });
    s = advance(s, 90); // ~4.5 tiles of travel — closes in but doesn't yet reach
    const e = s.enemies[added.id];
    expect(e).toBeDefined();
    const now = hexDistance(
      { x: Math.round(e.x), y: Math.round(e.y) },
      { x: Math.round(s.units[id].x), y: Math.round(s.units[id].y) },
    );
    expect(now).toBeLessThan(start);
  });

  it("stops on a tile centre when it reaches its target", () => {
    let s = createInitialState(555);
    const id = firstUnitId(s);
    // High HP so the defender survives the approach; we inspect the goblin the
    // moment it first becomes adjacent.
    const unit = { ...s.units[id], x: HAMLET_CENTER.x, y: HAMLET_CENTER.y + 4, hp: 999, order: { type: "idle" as const } };
    s = { ...s, units: { [id]: unit } };
    const added = addEnemy(s, "goblin", HAMLET_CENTER.x, HAMLET_CENTER.y - 4);
    s = added.s;

    let engaged = false;
    for (let i = 0; i < 200; i++) {
      s = advance(s, 1);
      const e = s.enemies[added.id];
      const u = s.units[id];
      if (!e || !u) break;
      const adj = hexDistance(
        { x: Math.round(e.x), y: Math.round(e.y) },
        { x: Math.round(u.x), y: Math.round(u.y) },
      ) <= 1;
      if (adj) {
        // On engaging it must hold on a hex centre, not a fractional mid-tile spot.
        expect(Number.isInteger(e.x)).toBe(true);
        expect(Number.isInteger(e.y)).toBe(true);
        engaged = true;
        break;
      }
    }
    expect(engaged).toBe(true);
  });

  it("batters a building when no unit is in reach", () => {
    let s = createInitialState(556);
    s = { ...s, units: {} }; // no defenders → the goblin targets a building
    const house = Object.values(s.buildings).find((b) => b.kind === "house")!;
    const spot = hexNeighbors(house.x, house.y)[0];
    s = addEnemy(s, "goblin", spot.x, spot.y).s;

    const before = totalBuildingHp(s);
    s = advance(s, 300); // ~10 swings — building loses HP (can't all roll 0)
    expect(totalBuildingHp(s)).toBeLessThan(before);
  });
});

describe("attacking a moving goblin (regression)", () => {
  it("does not crash when ordered onto a goblin caught mid-march", () => {
    let s = createInitialState(555);
    const id = firstUnitId(s);
    const unit = { ...s.units[id], x: HAMLET_CENTER.x, y: HAMLET_CENTER.y + 4, order: { type: "idle" as const } };
    s = { ...s, units: { [id]: unit } };
    const added = addEnemy(s, "goblin", HAMLET_CENTER.x, HAMLET_CENTER.y - 4);
    s = added.s;

    // Let the goblin march a few ticks so it sits at a fractional position — the
    // exact state that used to throw "Cannot read properties of undefined" out of
    // hexNeighbors when startAttack pathed to enemy.x/enemy.y.
    s = advance(s, 5);
    const e = s.enemies[added.id];
    expect(Number.isInteger(e.x) && Number.isInteger(e.y)).toBe(false); // mid-move

    expect(() => {
      s = update(s, [{ type: "attack", unitIds: [id], targetEnemyId: added.id }], 1);
    }).not.toThrow();
    expect(s.units[id].order.type).toBe("attack");
  });
});

describe("water predators (req §17.3)", () => {
  it("strike an adjacent unit even when it isn't fishing", () => {
    let s = createInitialState(557);
    const id = firstUnitId(s);
    // A high-HP idle unit beside the predator. A kraken rolls 1-3 through a
    // worker's 0 defence, so every swing lands ≥1 and survives the worker's
    // 0-1 counter-damage long enough to draw blood within a few seconds.
    const unit = { ...s.units[id], x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, hp: 50, order: { type: "idle" as const } };
    s = { ...s, units: { [id]: unit } };
    const n = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = addEnemy(s, "kraken", n.x, n.y).s;

    s = advance(s, 90);
    // A water predator now strikes any adjacent unit, not just a fisher.
    expect(s.units[id]).toBeDefined();
    expect(s.units[id].hp).toBeLessThan(50);
  });

  it("hunt within the water toward the nearest unit (req §14)", () => {
    let s = createInitialState(557);
    const shore = findShore(s);
    const id = firstUnitId(s);
    // Park a high-HP idle unit on the shore tile so the predator has a target it
    // can reach via an adjacent water tile.
    const unit = { ...s.units[id], x: shore.land.x, y: shore.land.y, hp: 999, order: { type: "idle" as const } };
    s = { ...s, units: { [id]: unit } };

    // Pick the farthest water tile reachable through water from the shore (a BFS
    // over the same lake), so a water-only path to the unit is guaranteed to exist.
    const seen = new Set<number>([shore.water.y * s.map.width + shore.water.x]);
    const queue = [shore.water];
    let far = shore.water;
    let farD = -1;
    while (queue.length) {
      const t = queue.shift()!;
      const d = hexDistance(t, shore.land);
      if (d > 1 && d > farD) { farD = d; far = t; }
      for (const n of hexNeighbors(t.x, t.y)) {
        if (!inBounds(s.map, n.x, n.y)) continue;
        const idx = n.y * s.map.width + n.x;
        if (seen.has(idx) || tileAt(s.map, n.x, n.y) !== "water") continue;
        seen.add(idx);
        queue.push(n);
      }
    }
    if (farD < 0) throw new Error("need a non-adjacent reachable water tile");
    const added = addEnemy(s, "seaSerpent", far.x, far.y);
    s = added.s;

    const start = hexDistance(far, shore.land);
    s = advance(s, 120);
    const e = s.enemies[added.id];
    expect(e).toBeDefined();
    // It closed in and never left the water.
    expect(tileAt(s.map, Math.round(e.x), Math.round(e.y))).toBe("water");
    const now = hexDistance({ x: Math.round(e.x), y: Math.round(e.y) }, shore.land);
    expect(now).toBeLessThan(start);
  });

  it("persist until the start of their spawn season one year later (req §17.3)", () => {
    let s = createInitialState(558);
    // Surface a serpent early in Spring of year 1 (spawn tick aligned to the
    // year/Spring boundary at tick 0).
    s = { ...s, tickCount: 10 };
    const added = addEnemy(s, "seaSerpent", HAMLET_CENTER.x, HAMLET_CENTER.y - 3, 0);
    s = added.s;

    // It survives the Fall→Winter boundary — there's no blanket winter despawn now.
    s = { ...s, tickCount: TICKS_PER_SEASON * 3 - 1 };
    s = update(s, [], 1);
    expect(s.enemies[added.id]).toBeDefined();

    // And it leaves at the start of Spring (its spawn season) the next year, once
    // a full year has elapsed since it surfaced.
    s = { ...s, tickCount: TICKS_PER_YEAR - 1 };
    s = update(s, [], 1);
    expect(s.enemies[added.id]).toBeUndefined();
  });
});

describe("enemy-sighting notifications", () => {
  it("a mine goblin raises an enemy notice carrying the combat location", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const m = findMountain(s);
    // Wood for the mine + food so the miner survives the season upkeep crossed.
    s = { ...s, resources: { ...s.resources, wood: 10, meat: 999, wheat: 999 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "mine", tx: m.x, ty: m.y }], 1);
    s = advance(s, TICKS_PER_SECOND * 60); // walk + build the mine

    // Force an iron vein so mining actually draws goblins (§13.2: stone is safe).
    const idx = m.y * s.map.width + m.x;
    s = { ...s, map: { ...s.map, mineType: { ...s.map.mineType, [idx]: "iron" } } };

    // Mine until a goblin spawns (0.15/yield). The worker caps its cart at 5 and
    // idles, so empty it and re-issue the order each time to keep yields flowing.
    let spawned = false;
    for (let i = 0; i < 8000 && !spawned; i++) {
      const u = s.units[id];
      if (u && u.order.type === "idle") {
        s = { ...s, units: { ...s.units, [id]: { ...u, carrying: {} } } };
        s = update(s, [{ type: "gather", unitIds: [id], tx: m.x, ty: m.y }], 1);
      } else {
        s = update(s, [], 1);
      }
      spawned = Object.keys(s.enemies).length > 0;
    }
    expect(spawned).toBe(true);

    const note = s.notifications.find((n) => n.kind === "enemy");
    expect(note).toBeDefined();
    // The notice points at a real tile so clicking it can centre the camera.
    expect(typeof note!.x).toBe("number");
    expect(typeof note!.y).toBe("number");
  });
});
