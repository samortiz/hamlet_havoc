// M4 — Seasons, time & upkeep (req §6.3, §11, §12, §15). Headless sim tests for
// end-of-season upkeep + demotion, crop loss, forest regrowth, season-locked
// farming actions, and seasonal fishing variance. Mechanics live here; the e2e
// suite only confirms wiring.

import { describe, expect, it } from "vitest";
import {
  FISH_TICKS_BY_SEASON,
  TICKS_PER_SEASON,
  TICKS_PER_SECOND,
  TICKS_PER_YEAR,
  UNIT_MAX_HP,
} from "../src/config/index.js";
import { fieldAt, type Field } from "../src/game/fields.js";
import { forestRemaining, HAMLET_CENTER, tileAt } from "../src/game/map.js";
import { createInitialState, deriveSeason, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";
import type { Unit, UnitKind } from "../src/game/units.js";

function workerIds(s: GameState): number[] {
  return Object.values(s.units).filter((u) => u.kind === "worker").map((u) => u.id);
}
function countKind(s: GameState, kind: UnitKind): number {
  return Object.values(s.units).filter((u) => u.kind === kind).length;
}
function carriedMeat(s: GameState): number {
  let m = s.resources.meat;
  for (const u of Object.values(s.units)) m += u.carrying.meat ?? 0;
  return m;
}
// Promote an existing unit to a given rank in-place (test fixture only).
function setKind(s: GameState, id: number, kind: UnitKind): GameState {
  const u = s.units[id];
  const next: Unit = { ...u, kind, hp: UNIT_MAX_HP[kind] };
  return { ...s, units: { ...s.units, [id]: next } };
}
function findTile(s: GameState, type: string): { x: number; y: number } {
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] === type) return { x, y };
    }
  }
  throw new Error(`no ${type} tile`);
}

describe("end-of-season upkeep + demotion (req §6.3)", () => {
  it("workers fed from the pool survive the season boundary", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, wheat: 10, meat: 0 } };
    expect(countKind(s, "worker")).toBe(4);

    s = update(s, [], TICKS_PER_SEASON); // reach end of spring → upkeep charged
    expect(countKind(s, "worker")).toBe(4); // all fed
    expect(s.resources.wheat).toBe(6); // 4 workers × 1 food from wheat
  });

  it("unfed workers die; only the number the pool can feed survive", () => {
    let s = createInitialState(2024);
    // Food for exactly 2 of the 4 workers.
    s = { ...s, resources: { ...s.resources, wheat: 2, meat: 0 } };
    s = update(s, [], TICKS_PER_SEASON);
    expect(countKind(s, "worker")).toBe(2);
    expect(s.resources.wheat).toBe(0);
  });

  it("a soldier with no meat is demoted to a worker, not lost", () => {
    let s = createInitialState(2024);
    const sid = workerIds(s)[0];
    s = setKind(s, sid, "soldier");
    // Plenty of wheat for the workers, but no meat for the soldier.
    s = { ...s, resources: { ...s.resources, wheat: 50, meat: 0 } };

    s = update(s, [], TICKS_PER_SEASON);
    expect(s.units[sid].kind).toBe("worker"); // demoted, still alive
  });

  it("a captain with no gold is demoted to a soldier", () => {
    let s = createInitialState(2024);
    const cid = workerIds(s)[0];
    s = setKind(s, cid, "captain");
    // Feed workers (wheat) and any soldiers (meat), but give no gold.
    s = { ...s, resources: { ...s.resources, wheat: 50, meat: 50, gold: 0 } };

    s = update(s, [], TICKS_PER_SEASON);
    expect(s.units[cid].kind).toBe("soldier");
  });

  it("a captain paid gold keeps rank and the gold is spent", () => {
    let s = createInitialState(2024);
    const cid = workerIds(s)[0];
    s = setKind(s, cid, "captain");
    s = { ...s, resources: { ...s.resources, wheat: 50, meat: 50, gold: 5 } };

    s = update(s, [], TICKS_PER_SEASON);
    expect(s.units[cid].kind).toBe("captain");
    expect(s.resources.gold).toBe(4); // 1 gold upkeep
  });

  it("soldiers claim meat before workers, so workers fall back to wheat", () => {
    let s = createInitialState(2024);
    const sid = workerIds(s)[0];
    s = setKind(s, sid, "soldier"); // 3 workers + 1 soldier
    // Exactly 1 meat (for the soldier) and enough wheat for the 3 workers.
    s = { ...s, resources: { ...s.resources, wheat: 10, meat: 1 } };

    s = update(s, [], TICKS_PER_SEASON);
    expect(s.units[sid].kind).toBe("soldier"); // soldier kept its meat
    expect(s.resources.meat).toBe(0);
    expect(s.resources.wheat).toBe(7); // 3 workers fed from wheat
    expect(countKind(s, "worker")).toBe(3);
  });
});

describe("upkeep notifications (T7)", () => {
  it("emits a death notification when a worker starves", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, wheat: 0, meat: 0 } }; // no food
    s = update(s, [], TICKS_PER_SEASON);
    expect(countKind(s, "worker")).toBe(0); // all four starved
    const deaths = s.notifications.filter((n) => n.kind === "death");
    expect(deaths.length).toBe(4);
  });

  it("emits a demotion notification when a soldier is demoted", () => {
    let s = createInitialState(2024);
    const sid = workerIds(s)[0];
    s = setKind(s, sid, "soldier");
    s = { ...s, resources: { ...s.resources, wheat: 50, meat: 0 } };
    s = update(s, [], TICKS_PER_SEASON);
    const demotions = s.notifications.filter((n) => n.kind === "demotion");
    expect(demotions.length).toBe(1);
  });

  it("does not emit notifications when all upkeep is paid", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, wheat: 50, meat: 50 } };
    s = update(s, [], TICKS_PER_SEASON);
    expect(s.notifications.length).toBe(0);
  });
});

describe("crop loss at fall's end (req §11.5)", () => {
  function withGrownField(s: GameState): { s: GameState; fieldId: number } {
    const fieldId = 5000;
    const f: Field = {
      id: fieldId,
      kind: "wheat",
      x: 10,
      y: 10,
      stage: "grown",
      hp: 5,
      plantedTick: 0,
      buildProgress: 0,
    };
    return { s: { ...s, fields: { ...s.fields, [fieldId]: f } }, fieldId };
  }

  it("a grown crop survives summer's end but is lost when fall ends", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, meat: 999 } }; // keep workers alive
    const built = withGrownField(s);
    s = built.s;

    // Through end of summer (tick 2·season): not fall yet, crop intact.
    s = update(s, [], TICKS_PER_SEASON * 2);
    expect(fieldAt(s.fields, 10, 10)!.stage).toBe("grown");

    // Through end of fall (tick 3·season): unharvested crop is cleared.
    s = update(s, [], TICKS_PER_SEASON);
    expect(fieldAt(s.fields, 10, 10)!.stage).toBe("ploughed");
  });
});

describe("forest regrowth at spring (req §12)", () => {
  it("a stump regrows to full forest only when spring begins", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, meat: 999 } };
    const forest = findTile(s, "forest");
    const idx = forest.y * s.map.width + forest.x;
    // Turn it into a depleted stump.
    s.map.tiles[idx] = "stump";
    s.map.forestWood[idx] = 0;

    // Still a stump after three seasons (no spring boundary crossed yet).
    s = update(s, [], TICKS_PER_SEASON * 3);
    expect(tileAt(s.map, forest.x, forest.y)).toBe("stump");

    // Crossing into spring of the next year regrows it.
    s = update(s, [], TICKS_PER_SEASON);
    expect(tileAt(s.map, forest.x, forest.y)).toBe("forest");
    expect(forestRemaining(s.map, idx)).toBeGreaterThan(0);
  });
});

describe("season-locked farming actions (req §15.3)", () => {
  it("planting is rejected outside spring", () => {
    let s = createInitialState(2024);
    const id = workerIds(s)[0];
    s = { ...s, resources: { ...s.resources, meat: 999, wheat: 10 } };
    // A grass tile in the starting clearing (req §4.3).
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;
    // Plough in spring.
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed");

    // Advance into summer, then attempt to plant.
    s = update(s, [], TICKS_PER_SEASON);
    expect(deriveSeason(s.tickCount).season).toBe("Summer");
    const wheatBefore = s.resources.wheat;
    s = update(s, [{ type: "field", unitIds: [id], action: "plant", tx, ty }], 1);
    expect(s.units[id].order.type).toBe("idle"); // command refused
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed"); // unchanged
    expect(s.resources.wheat).toBe(wheatBefore); // no seed consumed
  });

  it("harvesting is rejected outside fall", () => {
    let s = createInitialState(2024);
    const id = workerIds(s)[0];
    const fieldId = 6000;
    const f: Field = {
      id: fieldId, kind: "wheat", x: 10, y: 10, stage: "grown",
      hp: 5, plantedTick: 0, buildProgress: 0,
    };
    s = { ...s, fields: { ...s.fields, [fieldId]: f } };
    // Currently spring (tick 0): harvest must be refused.
    expect(deriveSeason(s.tickCount).season).toBe("Spring");
    s = update(s, [{ type: "field", unitIds: [id], action: "harvest", tx: 10, ty: 10 }], 1);
    expect(s.units[id].order.type).toBe("idle");
    expect(fieldAt(s.fields, 10, 10)!.stage).toBe("grown"); // crop still standing
  });
});

describe("seasonal fishing variance (req §14, §15.3)", () => {
  it("the rate table is faster in summer and slower in winter than the base", () => {
    expect(FISH_TICKS_BY_SEASON.Summer).toBeLessThan(FISH_TICKS_BY_SEASON.Spring);
    expect(FISH_TICKS_BY_SEASON.Winter).toBeGreaterThan(FISH_TICKS_BY_SEASON.Spring);
  });

  it("fishing yields more meat in a summer window than in a winter window", () => {
    const water = findTile(createInitialState(2024), "water");

    // Fish for a fixed window that starts exactly at a season's first tick (so
    // no upkeep boundary falls inside the measurement) and stays in-season.
    function meatFishedIn(startTick: number): number {
      let s = createInitialState(2024);
      const id = workerIds(s)[0];
      // Wheat (within storage cap) covers setup-phase upkeep so meat stays 0
      // going into the measurement window and reflects only what was fished.
      s = { ...s, resources: { ...s.resources, wheat: 20, meat: 0 } };
      s = update(s, [], startTick); // advance idle to the season's start tick
      expect(s.resources.meat).toBe(0); // upkeep was paid from wheat
      s = update(s, [{ type: "gather", unitIds: [id], tx: water.x, ty: water.y }], 1);
      s = update(s, [], TICKS_PER_SECOND * 40); // window stays inside the season
      return carriedMeat(s);
    }

    const summer = meatFishedIn(TICKS_PER_SEASON); // tick = start of summer
    const winter = meatFishedIn(TICKS_PER_SEASON * 3); // tick = start of winter
    expect(summer).toBeGreaterThan(0);
    expect(winter).toBeGreaterThan(0);
    expect(summer).toBeGreaterThan(winter);
  });
});

describe("a full year cycles correctly (req §15)", () => {
  it("returns to spring of the next year after four seasons", () => {
    let s = createInitialState(2024);
    s = { ...s, resources: { ...s.resources, meat: 999 } }; // keep the hamlet fed
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(deriveSeason(s.tickCount).season);
      s = update(s, [], TICKS_PER_SEASON);
    }
    expect(seen).toEqual(["Spring", "Summer", "Fall", "Winter"]);
    const info = deriveSeason(s.tickCount);
    expect(info.season).toBe("Spring");
    expect(info.year).toBe(2);
    expect(s.tickCount).toBe(TICKS_PER_YEAR);
  });
});
