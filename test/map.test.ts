import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH } from "../src/config/index.js";
import { makeBuilding } from "../src/game/buildings.js";
import {
  countTiles,
  generateMap,
  HAMLET_CENTER,
  isWalkable,
  mountainTypeAt,
  tileAt,
} from "../src/game/map.js";

describe("map generation", () => {
  it("produces a full-size map deterministically for a seed", () => {
    const a = generateMap(123).map;
    const b = generateMap(123).map;
    expect(a.width).toBe(MAP_WIDTH);
    expect(a.height).toBe(MAP_HEIGHT);
    expect(a.tiles.length).toBe(MAP_WIDTH * MAP_HEIGHT);
    expect(a.tiles).toEqual(b.tiles);
  });

  it("differs across seeds", () => {
    expect(generateMap(1).map.tiles).not.toEqual(generateMap(2).map.tiles);
  });

  it("meets minimum terrain coverage (req §4.3)", () => {
    const map = generateMap(777).map;
    const n = MAP_WIDTH * MAP_HEIGHT;
    expect(countTiles(map, "forest") / n).toBeGreaterThanOrEqual(0.1);
    expect(countTiles(map, "water") / n).toBeGreaterThanOrEqual(0.05);
    expect(countTiles(map, "mountain") / n).toBeGreaterThanOrEqual(0.05);
  });

  it("keeps the hamlet clearing as grass for the starting buildings/units", () => {
    const map = generateMap(777).map;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(tileAt(map, HAMLET_CENTER.x + dx, HAMLET_CENTER.y + dy)).toBe(
          "grass",
        );
      }
    }
  });

  it("provides every gathering terrain near the hamlet (req §4.3)", () => {
    const map = generateMap(777).map;
    const seen = new Set<string>();
    const R = 9;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = HAMLET_CENTER.x + dx;
        const y = HAMLET_CENTER.y + dy;
        if (x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT) {
          seen.add(tileAt(map, x, y));
        }
      }
    }
    expect(seen.has("forest")).toBe(true);
    expect(seen.has("water")).toBe(true);
    expect(seen.has("mountain")).toBe(true);
  });

  it("assigns a rock type to every mountain tile, deterministically", () => {
    const a = generateMap(777);
    const b = generateMap(777);
    let mountains = 0;
    for (let i = 0; i < a.map.tiles.length; i++) {
      if (a.map.tiles[i] !== "mountain") continue;
      mountains++;
      const t = a.map.mountainType[i];
      expect(t).toMatch(/stone|iron|gold/);
      expect(b.map.mountainType[i]).toBe(t); // same seed → same types
    }
    expect(mountains).toBeGreaterThan(0);
    // No type entries leak onto non-mountain tiles.
    expect(Object.keys(a.map.mountainType).length).toBe(mountains);
  });

  it("mountainTypeAt falls back to stone for old saves with no entry", () => {
    const map = generateMap(5).map;
    const fresh = { ...map, mountainType: {} };
    expect(mountainTypeAt(fresh, 0)).toBe("stone");
  });

  it("isWalkable: out-of-bounds blocked, water blocked, hamlet open", () => {
    const map = generateMap(5).map;
    expect(isWalkable(map, -1, 0)).toBe(false);
    expect(isWalkable(map, MAP_WIDTH, 0)).toBe(false);
    expect(isWalkable(map, HAMLET_CENTER.x, HAMLET_CENTER.y)).toBe(true);
  });

  it("isWalkable: a mountain is impassable until a built mine sits on it (req §13)", () => {
    const map = generateMap(5).map;
    let mx = -1, my = -1;
    for (let y = 0; y < map.height && mx < 0; y++) {
      for (let x = 0; x < map.width; x++) {
        if (tileAt(map, x, y) === "mountain") { mx = x; my = y; break; }
      }
    }
    expect(mx).toBeGreaterThanOrEqual(0);

    // No building context, or none on the tile → impassable.
    expect(isWalkable(map, mx, my)).toBe(false);
    expect(isWalkable(map, mx, my, {})).toBe(false);

    // An under-construction mine does not yet open the tile…
    const pending = makeBuilding(1, "mine", mx, my, { built: false });
    expect(isWalkable(map, mx, my, { 1: pending })).toBe(false);

    // …but a completed mine makes the mountain walkable.
    const built = makeBuilding(1, "mine", mx, my, { built: true });
    expect(isWalkable(map, mx, my, { 1: built })).toBe(true);
  });
});
