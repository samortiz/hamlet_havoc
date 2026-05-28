import { describe, expect, it } from "vitest";
import type { GameMap, TileType } from "../src/game/map.js";
import { findPath } from "../src/game/pathfinding.js";

// "." = grass (walkable), "~" = water (blocked).
function makeMap(rows: string[]): GameMap {
  const height = rows.length;
  const width = rows[0].length;
  const tiles: TileType[] = [];
  for (const row of rows) {
    for (const ch of row) tiles.push(ch === "~" ? "water" : "grass");
  }
  return { width, height, tiles, forestWood: {}, mineType: {} };
}

describe("findPath", () => {
  it("returns [] when already at the goal", () => {
    const m = makeMap(["...", "...", "..."]);
    expect(findPath(m, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it("finds a straight path ending exactly at the goal", () => {
    const m = makeMap(["....."]);
    const p = findPath(m, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(p).not.toBeNull();
    expect(p!.length).toBe(4);
    expect(p![p!.length - 1]).toEqual({ x: 4, y: 0 });
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

  it("returns null when the goal is unreachable", () => {
    // (0,0) is sealed off by water (no diagonal corner-cutting allowed).
    const m = makeMap([".~.", "~~.", "..."]);
    expect(findPath(m, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it("is deterministic for the same inputs", () => {
    const m = makeMap(["......", ".~~~..", "......", "..~~~.", "......"]);
    const a = findPath(m, { x: 0, y: 0 }, { x: 5, y: 4 });
    const b = findPath(m, { x: 0, y: 0 }, { x: 5, y: 4 });
    expect(a).toEqual(b);
  });
});
