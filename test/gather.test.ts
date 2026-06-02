// Worker gather loop (req §10–§14): a worker walks to a resource tile, fills
// to its carry cap, deposits at the nearest storage, and (when applicable)
// returns for more. Headless sim tests; the e2e suite checks the browser path.
//
// These exercises run inside the opening Spring season (under 60s) or stock
// meat so end-of-season upkeep (§6.3) doesn't starve the worker mid-test.

import { describe, expect, it } from "vitest";
import { FOREST_WOOD_MAX, TICKS_PER_SECOND, WOOD_ROAM_RADIUS, WORKER_CARRY_CAP } from "../src/config/index.js";
import { storageCapacity } from "../src/game/buildings.js";
import { hexDistance } from "../src/game/hex.js";
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
    // Walk out + 5×5s chops + walk back + deposit; stays within the first season.
    s = update(s, [], TICKS_PER_SECOND * 50);

    // Forest tiles hold a random 1D6+2 wood now, so a tile may carry fewer than a
    // full load — but the worker fills (and deposits) at least one carry cap.
    expect(s.resources.wood).toBeGreaterThanOrEqual(WORKER_CARRY_CAP);
  });

  it("depletes a forest tile to a stump after FOREST_WOOD_MAX yields (req §12)", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const forest = findNearestTile(s, "forest", w.x, w.y)!;

    s = update(s, [{ type: "gather", unitIds: [id], tx: forest.x, ty: forest.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 50);

    expect(tileAt(s.map, forest.x, forest.y)).toBe("stump");
  });
});

// A forest tile that has at least one other forest tile within `radius` hexes,
// so a worker who chops it out has somewhere nearby to roam to.
function findForestWithNeighbor(
  s: GameState,
  radius: number,
): { x: number; y: number } | null {
  const W = s.map.width;
  const H = s.map.height;
  const isForest = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && s.map.tiles[y * W + x] === "forest";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isForest(x, y)) continue;
      for (let ny = y - radius; ny <= y + radius; ny++) {
        for (let nx = x - radius; nx <= x + radius; nx++) {
          if ((nx === x && ny === y) || hexDistance({ x, y }, { x: nx, y: ny }) > radius) continue;
          if (isForest(nx, ny)) return { x, y };
        }
      }
    }
  }
  return null;
}

describe("wood roaming (req: hop to a nearby tree once a tile is chopped out)", () => {
  it("keeps chopping a neighbouring forest tile after depleting the first", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const start = findForestWithNeighbor(s, WOOD_ROAM_RADIUS);
    expect(start).not.toBeNull();

    // Stock food so end-of-season upkeep (§6.3) doesn't starve the worker over
    // the multi-season run this needs to chop through more than one tile. Kept
    // modest so the pool (12 starting wheat + this) stays under storage cap and
    // leaves room for the gathered wood to land.
    s = { ...s, resources: { ...s.resources, meat: 10 } };
    s = update(s, [{ type: "gather", unitIds: [id], tx: start!.x, ty: start!.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 200);

    // The first tile is now a stump...
    expect(tileAt(s.map, start!.x, start!.y)).toBe("stump");
    // ...and more than one tile's worth of wood was gathered, which is only
    // possible if the worker roamed to a second tree rather than stopping.
    const w = s.units[id];
    const total = s.resources.wood + (w.carrying.wood ?? 0);
    expect(total).toBeGreaterThan(FOREST_WOOD_MAX);
  });
});

describe("fishing", () => {
  it("a worker fishes from a tile adjacent to water and accumulates meat", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const water = findNearestTile(s, "water", w.x, w.y)!;

    s = update(s, [{ type: "gather", unitIds: [id], tx: water.x, ty: water.y }], 1);
    // Within the opening Spring, so the meat measured is purely fished (no upkeep).
    s = update(s, [], TICKS_PER_SECOND * 50);

    expect(s.resources.meat).toBeGreaterThan(0);
  });
});

describe("mining", () => {
  it("mining yields a stone/iron/gold(/diamond) resource that reaches the pool", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const mountain = findNearestTile(s, "mountain", w.x, w.y)!;

    // Mining requires a built mine on the mountain tile (req §13).
    // Mine costs 4 wood — stock it and build the mine first, then mine it.
    // Stock some meat (within storage cap) so upkeep doesn't starve the miner
    // over the long run (§6.3) — kept modest so the pool (12 starting wheat +
    // this) stays under the storage cap and leaves room for the mined ore.
    s = { ...s, resources: { ...s.resources, wood: 6, meat: 8 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "mine", tx: mountain.x, ty: mountain.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 60);
    s = update(s, [{ type: "gather", unitIds: [id], tx: mountain.x, ty: mountain.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 250);

    // Mine yields surface as gathered ore — counted whether deposited to the pool
    // or still carried (a mine goblin (§13.2) may pin the miner before it banks).
    const u = s.units[id];
    const pooled = s.resources.stone + s.resources.iron + s.resources.gold + s.resources.diamond;
    const carried =
      (u?.carrying.stone ?? 0) + (u?.carrying.iron ?? 0) + (u?.carrying.gold ?? 0) + (u?.carrying.diamond ?? 0);
    expect(pooled + carried).toBeGreaterThan(0);
  });

  it("gathering on a bare mountain (no mine) is a no-op", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const mountain = findNearestTile(s, "mountain", w.x, w.y)!;
    s = update(s, [{ type: "gather", unitIds: [id], tx: mountain.x, ty: mountain.y }], 1);
    expect(s.units[id].order.type).toBe("idle");
  });

  it("snaps a miner to the tile centre when it mines from its own tile (req §13)", () => {
    let s = createInitialState(777);
    const id = firstWorkerId(s);
    const w = s.units[id];
    const mountain = findNearestTile(s, "mountain", w.x, w.y)!;
    // Build the mine first so the mountain is both mineable and walkable.
    s = { ...s, resources: { ...s.resources, wood: 6, meat: 8 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "mine", tx: mountain.x, ty: mountain.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 60);

    // Stand the miner on the mine's own tile but at a fractional position (as if
    // caught mid-march), then order it to mine. The work tile is its own tile, so
    // the path is empty and nothing walks it — it must still snap to the centre.
    s = { ...s, units: { ...s.units, [id]: { ...s.units[id], x: mountain.x + 0.4, y: mountain.y - 0.3 } } };
    s = update(s, [{ type: "gather", unitIds: [id], tx: mountain.x, ty: mountain.y }], 1);

    expect(s.units[id].order.type).toBe("gather");
    expect(Number.isInteger(s.units[id].x)).toBe(true);
    expect(Number.isInteger(s.units[id].y)).toBe(true);
    expect(s.units[id].x).toBe(mountain.x);
    expect(s.units[id].y).toBe(mountain.y);
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
    // Kept under the first season boundary so upkeep doesn't eat from the pool.
    s = update(s, [], TICKS_PER_SECOND * 50);

    // Cap reached, not exceeded.
    expect(poolTotal(s.resources)).toBe(cap);
    // The worker still holds the overflow it couldn't deposit.
    const carriedWood = s.units[id].carrying.wood ?? 0;
    expect(carriedWood).toBeGreaterThan(0);
    // ...and stops working because the pool is full.
    expect(s.units[id].order.type).toBe("idle");
  });
});
