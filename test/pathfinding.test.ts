// A* pathfinding tests on the hex grid (req §6.5). Uniform cost per hop,
// hex-distance heuristic, no diagonal-cutting concept. Each test builds a
// small ASCII map (each row is a literal hex row in odd-r offset coords;
// "." = grass, "~" = water).

import { describe, expect, it } from "vitest";
import { hexDistance } from "../src/game/hex.js";
import type { GameMap, TileType } from "../src/game/map.js";
import { findPath } from "../src/game/pathfinding.js";

function makeMap(rows: string[]): GameMap {
  const height = rows.length;
  const width = rows[0].length;
  const tiles: TileType[] = [];
  for (const row of rows) {
    for (const ch of row) tiles.push(ch === "~" ? "water" : "grass");
  }
  return { width, height, tiles, forestWood: {}, mineType: {}, mountainType: {} };
}

describe("findPath (hex A*)", () => {
  it("returns [] when already at the goal", () => {
    const m = makeMap(["...", "...", "..."]);
    expect(findPath(m, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it("finds a straight path along a row in exactly hex-distance hops", () => {
    const m = makeMap(["......."]);
    const p = findPath(m, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(p).not.toBeNull();
    expect(p!.length).toBe(4);
    expect(p![p!.length - 1]).toEqual({ x: 4, y: 0 });
  });

  it("path length matches hexDistance(start, goal) on an open map", () => {
    const m = makeMap([
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ]);
    const start = { x: 1, y: 1 };
    const goal = { x: 7, y: 4 };
    const p = findPath(m, start, goal);
    expect(p).not.toBeNull();
    expect(p!.length).toBe(hexDistance(start, goal));
  });

  it("each step in the path is a hex neighbor of the previous one", () => {
    const m = makeMap([
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ]);
    const start = { x: 0, y: 0 };
    const p = findPath(m, start, { x: 8, y: 3 })!;
    let prev = start;
    for (const step of p) {
      expect(hexDistance(prev, step)).toBe(1);
      prev = step;
    }
  });

  it("routes around water without stepping on it", () => {
    const m = makeMap([".....", "..~..", "..~..", "....."]);
    const p = findPath(m, { x: 2, y: 0 }, { x: 2, y: 3 });
    expect(p).not.toBeNull();
    for (const s of p!) expect(m.tiles[s.y * m.width + s.x]).not.toBe("water");
    expect(p![p!.length - 1]).toEqual({ x: 2, y: 3 });
  });

  it("returns null when the goal tile is water", () => {
    const m = makeMap(["...", "~~~", "..."]);
    expect(findPath(m, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("returns null when the start is surrounded by water in all 6 directions", () => {
    // (1, 1) is even-row; its 6 neighbours are (0,1) (2,1) (1,0) (0,0) (1,2) (0,2).
    // Wall those off with water so no escape.
    const m = makeMap([
      "~~~",
      "~.~",
      "~~~",
    ]);
    expect(findPath(m, { x: 1, y: 1 }, { x: 0, y: 0 })).toBeNull();
  });

  it("is deterministic for the same inputs", () => {
    const m = makeMap(["......", ".~~~..", "......", "..~~~.", "......"]);
    const a = findPath(m, { x: 0, y: 0 }, { x: 5, y: 4 });
    const b = findPath(m, { x: 0, y: 0 }, { x: 5, y: 4 });
    expect(a).toEqual(b);
  });
});
