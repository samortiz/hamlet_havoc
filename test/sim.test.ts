// Headless simulation tests (req §2.10). These exercise the sim core with no
// canvas/DOM, proving the render/sim separation and the determinism/save design.

import { describe, expect, it } from "vitest";
import {
  SEASONS,
  TICKS_PER_SEASON,
  TICKS_PER_YEAR,
} from "../src/config/index.js";
import { rngInt, rngNext } from "../src/game/rng.js";
import { createInitialState, deriveSeason } from "../src/game/state.js";
import { update } from "../src/game/update.js";
import { deserialize, serialize } from "../src/game/persistence.js";

describe("update", () => {
  it("advances the tick count by dtTicks each step", () => {
    let state = createInitialState(1);
    expect(state.tickCount).toBe(0);
    state = update(state, [], 1);
    expect(state.tickCount).toBe(1);
    state = update(state, [], 5);
    expect(state.tickCount).toBe(6);
  });

  it("does not mutate the input state (pure step)", () => {
    const state = createInitialState(1);
    const next = update(state, [], 1);
    expect(state.tickCount).toBe(0);
    expect(next).not.toBe(state);
  });

  it("running N single ticks equals one advance of N (fixed timestep)", () => {
    let stepwise = createInitialState(42);
    for (let i = 0; i < 100; i++) stepwise = update(stepwise, [], 1);
    const bulk = update(createInitialState(42), [], 100);
    expect(stepwise.tickCount).toBe(bulk.tickCount);
  });
});

describe("seeded rng", () => {
  it("is deterministic for a given seed", () => {
    const seqA: number[] = [];
    const seqB: number[] = [];
    let a = 12345;
    let b = 12345;
    for (let i = 0; i < 10; i++) {
      let v: number;
      [a, v] = rngNext(a);
      seqA.push(v);
      [b, v] = rngNext(b);
      seqB.push(v);
    }
    expect(seqA).toEqual(seqB);
  });

  it("produces floats in [0, 1)", () => {
    let s = 7;
    for (let i = 0; i < 1000; i++) {
      let v: number;
      [s, v] = rngNext(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("rngInt stays within inclusive bounds and can hit both ends", () => {
    let s = 99;
    let sawMin = false;
    let sawMax = false;
    for (let i = 0; i < 2000; i++) {
      let v: number;
      [s, v] = rngInt(s, 0, 2);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(2);
      if (v === 0) sawMin = true;
      if (v === 2) sawMax = true;
    }
    expect(sawMin && sawMax).toBe(true);
  });
});

describe("save / load", () => {
  it("round-trips state through JSON to an equal value", () => {
    let state = createInitialState(2024);
    state = update(state, [], 137);
    const restored = deserialize(serialize(state));
    expect(restored).toEqual(state);
  });

  it("rejects an unknown save version", () => {
    expect(() => deserialize(JSON.stringify({ version: 999 }))).toThrow();
  });

  it("round-trips a state that has gathered resources and a depleted forest", () => {
    let state = createInitialState(2024);
    const id = Number(Object.keys(state.units)[0]);
    const u = state.units[id];
    // Find any forest tile to gather from.
    let forest: { x: number; y: number } | null = null;
    for (let y = 0; y < state.map.height && !forest; y++) {
      for (let x = 0; x < state.map.width; x++) {
        if (state.map.tiles[y * state.map.width + x] === "forest") {
          forest = { x, y };
          break;
        }
      }
    }
    state = update(
      state,
      [{ type: "gather", unitIds: [id], tx: forest!.x, ty: forest!.y }],
      1,
    );
    // Long enough to walk + chop + deplete + carry/deposit something.
    state = update(state, [], 30 * 200);
    expect(state.resources.wood).toBeGreaterThan(0);
    expect(state.units[id].order.type).not.toBe(undefined);
    expect(u).not.toBe(state.units[id]);

    const restored = deserialize(serialize(state));
    expect(restored).toEqual(state);
  });
});

describe("deriveSeason", () => {
  it("starts at Spring, Year 1", () => {
    const info = deriveSeason(0);
    expect(info.season).toBe("Spring");
    expect(info.year).toBe(1);
    expect(info.secondsRemaining).toBe(60);
  });

  it("advances through the four seasons within a year", () => {
    expect(deriveSeason(TICKS_PER_SEASON).season).toBe("Summer");
    expect(deriveSeason(TICKS_PER_SEASON * 2).season).toBe("Fall");
    expect(deriveSeason(TICKS_PER_SEASON * 3).season).toBe("Winter");
  });

  it("rolls over to the next year after winter", () => {
    const info = deriveSeason(TICKS_PER_YEAR);
    expect(info.season).toBe("Spring");
    expect(info.year).toBe(2);
  });

  it("covers every season label exactly once per year", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SEASONS.length; i++) {
      seen.add(deriveSeason(i * TICKS_PER_SEASON).season);
    }
    expect(seen.size).toBe(SEASONS.length);
  });
});
