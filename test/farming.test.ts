// Farming lifecycle (req §11): plough -> plant (costs 1 wheat) -> grow ->
// harvest (yields a random WHEAT_HARVEST_MIN..MAX) -> field reverts to ploughed.
// Planting is spring-locked and harvest is fall-locked (§15.3); the timing below
// keeps each step inside its legal season. End-of-season upkeep eats meat first (§6.3), so
// stocking meat keeps the wheat we measure here untouched.

import { describe, expect, it } from "vitest";
import {
  CROP_GROW_TICKS,
  HARVEST_TICKS,
  PLANT_TICKS,
  PLANT_WHEAT_COST,
  STARTING_WHEAT,
  TICKS_PER_SEASON,
  TICKS_PER_SECOND,
  WHEAT_HARVEST_MAX,
  WHEAT_HARVEST_MIN,
} from "../src/config/index.js";
import { fieldAt } from "../src/game/fields.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { deriveSeason, createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstWorkerId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}

describe("farming lifecycle", () => {
  it("plough -> plant -> grow -> harvest produces wheat and replants the field", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    // Stock meat (within storage cap) so end-of-season upkeep (§6.3) is paid
    // from meat, leaving the wheat we measure untouched (workers eat meat first).
    s = { ...s, resources: { ...s.resources, meat: 20 } };
    // A grass tile inside the clearing, away from the starting buildings.
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;

    // 1) Plough — should create a ploughed field at (tx, ty). Spring (tick 0).
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    const ploughed = fieldAt(s.fields, tx, ty);
    expect(ploughed?.stage).toBe("ploughed");

    // 2) Plant — spring-locked; completes well before the spring→summer turn.
    expect(deriveSeason(s.tickCount).season).toBe("Spring");
    const wheatBefore = s.resources.wheat;
    expect(wheatBefore).toBeGreaterThanOrEqual(PLANT_WHEAT_COST);
    s = update(s, [{ type: "field", unitIds: [id], action: "plant", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    const planted = fieldAt(s.fields, tx, ty)!;
    expect(planted.stage).toBe("planted");
    expect(s.resources.wheat).toBe(wheatBefore - PLANT_WHEAT_COST);

    // 3) Grow — matures one season after planting; lands the crop in fall.
    s = update(s, [], CROP_GROW_TICKS + 1);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("grown");
    expect(deriveSeason(s.tickCount).season).toBe("Fall");

    // 4) Harvest — fall-locked; yields a random 10–20 wheat and resets to ploughed.
    const wheatBeforeHarvest = s.resources.wheat;
    s = update(s, [{ type: "field", unitIds: [id], action: "harvest", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    const gained = s.resources.wheat - wheatBeforeHarvest;
    expect(gained).toBeGreaterThanOrEqual(WHEAT_HARVEST_MIN);
    expect(gained).toBeLessThanOrEqual(WHEAT_HARVEST_MAX);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed");
  });

  it("plant is a no-op when the pool has no wheat", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    s = { ...s, resources: { ...s.resources, meat: 20 } }; // feed upkeep from meat
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;
    // Plough first (Spring).
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    // Drain wheat from the pool before planting.
    s = { ...s, resources: { ...s.resources, wheat: 0 } };
    s = update(s, [{ type: "field", unitIds: [id], action: "plant", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed"); // unchanged
    expect(s.resources.wheat).toBe(0);
  });

  it("an idle worker auto-plants a ploughed field in spring", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    s = { ...s, resources: { ...s.resources, meat: 12, wheat: 10 } };
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;

    // Plough (spring); the worker finishes standing idle on the new field tile.
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed");
    expect(deriveSeason(s.tickCount).season).toBe("Spring");

    // No command issued — the idle worker plants the field on its own.
    s = update(s, [], PLANT_TICKS + 1);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("planted");
  });

  it("an idle worker auto-harvests a grown field in fall", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;
    const fieldId = 7000;
    // Stand the worker on a ripe wheat field with the clock early in Fall.
    s = {
      ...s,
      tickCount: TICKS_PER_SEASON * 2 + 10,
      resources: { ...s.resources, wheat: 0 },
      units: { ...s.units, [id]: { ...s.units[id], x: tx, y: ty, order: { type: "idle" } } },
      fields: {
        [fieldId]: {
          id: fieldId, kind: "wheat", x: tx, y: ty,
          stage: "grown", hp: 5, plantedTick: 0, buildProgress: 0,
        },
      },
    };
    expect(deriveSeason(s.tickCount).season).toBe("Fall");

    // No command — the idle worker harvests the ripe field on its own.
    s = update(s, [], HARVEST_TICKS + 1);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed"); // harvested + reset
    expect(s.resources.wheat).toBeGreaterThanOrEqual(WHEAT_HARVEST_MIN);
  });

  it("starting wheat matches the §5 spec", () => {
    const s = createInitialState(1);
    expect(s.resources.wheat).toBe(STARTING_WHEAT);
  });
});
