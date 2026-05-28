import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND } from "../src/config/index.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstUnitId(state: GameState): number {
  return Number(Object.keys(state.units)[0]);
}

describe("unit movement", () => {
  it("idle units stay put", () => {
    let s = createInitialState(10);
    const id = firstUnitId(s);
    const { x, y } = s.units[id];
    for (let i = 0; i < 30; i++) s = update(s, [], 1);
    expect(s.units[id].x).toBe(x);
    expect(s.units[id].y).toBe(y);
  });

  it("a moveUnits order walks a unit to a reachable tile, then idles", () => {
    let s = createInitialState(10);
    const id = firstUnitId(s);
    const u = s.units[id];
    const tx = Math.round(u.x) + 1; // adjacent grass in the clearing
    const ty = Math.round(u.y);

    s = update(s, [{ type: "moveUnits", unitIds: [id], tx, ty }], 1);
    expect(s.units[id].order.type).toBe("move");

    // 1 tile at 1 tile/sec ≈ TICKS_PER_SECOND ticks; add a small margin.
    for (let i = 0; i < TICKS_PER_SECOND + 2; i++) s = update(s, [], 1);
    expect(s.units[id].x).toBeCloseTo(tx, 5);
    expect(s.units[id].y).toBeCloseTo(ty, 5);
    expect(s.units[id].order.type).toBe("idle");
  });

  it("ignores a move order to an unwalkable target (stays idle)", () => {
    let s = createInitialState(10);
    const id = firstUnitId(s);
    let target: { x: number; y: number } | null = null;
    for (let y = 0; y < s.map.height && !target; y++) {
      for (let x = 0; x < s.map.width; x++) {
        if (s.map.tiles[y * s.map.width + x] === "water") {
          target = { x, y };
          break;
        }
      }
    }
    expect(target).not.toBeNull();
    s = update(s, [{ type: "moveUnits", unitIds: [id], tx: target!.x, ty: target!.y }], 1);
    expect(s.units[id].order.type).toBe("idle");
  });

  it("movement is deterministic regardless of tick batching", () => {
    const base = createInitialState(10);
    const id = firstUnitId(base);
    const u = base.units[id];
    const cmd = {
      type: "moveUnits" as const,
      unitIds: [id],
      tx: Math.round(u.x) + 2,
      ty: Math.round(u.y),
    };

    let stepwise = update(base, [cmd], 1);
    for (let i = 0; i < 20; i++) stepwise = update(stepwise, [], 1);

    let bulk = update(base, [cmd], 1);
    bulk = update(bulk, [], 20);

    expect(bulk.units[id].x).toBeCloseTo(stepwise.units[id].x, 5);
    expect(bulk.units[id].y).toBeCloseTo(stepwise.units[id].y, 5);
  });

  it("state still round-trips through JSON with a map and units", () => {
    let s = createInitialState(10);
    const id = firstUnitId(s);
    s = update(s, [{ type: "moveUnits", unitIds: [id], tx: Math.round(s.units[id].x) + 1, ty: Math.round(s.units[id].y) }], 5);
    const restored = JSON.parse(JSON.stringify(s)) as GameState;
    expect(restored).toEqual(s);
  });
});
