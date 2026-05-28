// Worker gather loop (req §10–§14): a worker walks to a resource tile, fills
// to its carry cap, deposits at the nearest storage, and (when applicable)
// returns for more. Headless sim tests; the e2e suite checks the browser path.

import { describe, expect, it } from "vitest";
import { FOREST_WOOD_MAX, TICKS_PER_SECOND } from "../src/config/index.js";
import { storageCapacity } from "../src/game/buildings.js";
import { tileAt, type TileType } from "../src/game/map.js";
import { poolTotal } from "../src/game/resources.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstWorkerId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}

function findNearestTile(
  s: GameState,
  type: TileType,
  fromX: number,
  fromY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] === type) {
        const d = (x - fromX) ** 2 + (y - fromY) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
  }
  return best;
}

describe("wood gathering", () => {
  it("fills carry cap from a forest, deposits to the pool", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const forest = findNearestTile(s, "forest", w.x, w.y);
    expect(forest).not.toBeNull();

    s = update(s, [{ type: "gather", unitIds: [id], tx: forest!.x, ty: forest!.y }], 1);
    // Generous bulk advance: walk out + 5×15s chops + walk back + deposit.
    s = update(s, [], TICKS_PER_SECOND * 200);

    expect(s.resources.wood).toBeGreaterThanOrEqual(FOREST_WOOD_MAX);
  });

  it("depletes a forest tile to a stump after FOREST_WOOD_MAX yields (req §12)", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const forest = findNearestTile(s, "forest", w.x, w.y)!;

    s = update(s, [{ type: "gather", unitIds: [id], tx: forest.x, ty: forest.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 200);

    expect(tileAt(s.map, forest.x, forest.y)).toBe("stump");
  });
});

describe("fishing", () => {
  it("a worker fishes from a tile adjacent to water and accumulates meat", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const water = findNearestTile(s, "water", w.x, w.y)!;

    s = update(s, [{ type: "gather", unitIds: [id], tx: water.x, ty: water.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 200);

    expect(s.resources.meat).toBeGreaterThan(0);
  });
});

describe("mining", () => {
  it("mining yields a stone/iron/gold(/diamond) resource that reaches the pool", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const mountain = findNearestTile(s, "mountain", w.x, w.y)!;

    s = update(s, [{ type: "gather", unitIds: [id], tx: mountain.x, ty: mountain.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 250);

    const total = s.resources.stone + s.resources.iron + s.resources.gold + s.resources.diamond;
    expect(total).toBeGreaterThan(0);
  });
});

describe("deposit respects pooled storage capacity (req §8.1)", () => {
  it("only the amount that fits is deposited; the worker keeps the rest and idles", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const cap = storageCapacity(s.buildings);

    // Pre-fill the pool so only 1 unit of space remains.
    s = { ...s, resources: { ...s.resources, wood: cap - poolTotal(s.resources) - 1 } };
    expect(poolTotal(s.resources)).toBe(cap - 1);

    const forest = findNearestTile(s, "forest", w.x, w.y)!;
    s = update(s, [{ type: "gather", unitIds: [id], tx: forest.x, ty: forest.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 250);

    // Cap reached, not exceeded.
    expect(poolTotal(s.resources)).toBe(cap);
    // The worker still holds the overflow it couldn't deposit.
    const carriedWood = s.units[id].carrying.wood ?? 0;
    expect(carriedWood).toBeGreaterThan(0);
    // ...and stops working because the pool is full.
    expect(s.units[id].order.type).toBe("idle");
  });
});
