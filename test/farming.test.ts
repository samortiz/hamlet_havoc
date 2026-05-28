// Farming lifecycle (req §11): plough -> plant (costs 1 wheat) -> grow ->
// harvest (yields WHEAT_YIELD_PER_TILE) -> field reverts to ploughed for replant.
// M4 will add season gating + crop loss; M2 only owns the mechanic.

import { describe, expect, it } from "vitest";
import {
  CROP_GROW_TICKS,
  PLANT_WHEAT_COST,
  STARTING_WHEAT,
  TICKS_PER_SECOND,
  WHEAT_YIELD_PER_TILE,
} from "../src/config/index.js";
import { fieldAt } from "../src/game/fields.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstWorkerId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}

describe("farming lifecycle", () => {
  it("plough -> plant -> grow -> harvest produces wheat and replants the field", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    // A grass tile inside the clearing, away from the starting buildings.
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;

    // 1) Plough — should create a ploughed field at (tx, ty).
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    const ploughed = fieldAt(s.fields, tx, ty);
    expect(ploughed?.stage).toBe("ploughed");

    // 2) Plant — should consume 1 wheat from the pool and flip stage to planted.
    const wheatBefore = s.resources.wheat;
    expect(wheatBefore).toBeGreaterThanOrEqual(PLANT_WHEAT_COST);
    s = update(s, [{ type: "field", unitIds: [id], action: "plant", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    const planted = fieldAt(s.fields, tx, ty)!;
    expect(planted.stage).toBe("planted");
    expect(s.resources.wheat).toBe(wheatBefore - PLANT_WHEAT_COST);

    // 3) Grow — mature once enough ticks have passed.
    s = update(s, [], CROP_GROW_TICKS + 1);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("grown");

    // 4) Harvest — should yield WHEAT_YIELD_PER_TILE wheat and reset to ploughed.
    const wheatBeforeHarvest = s.resources.wheat;
    s = update(s, [{ type: "field", unitIds: [id], action: "harvest", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(s.resources.wheat).toBe(wheatBeforeHarvest + WHEAT_YIELD_PER_TILE);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed");
  });

  it("plant is a no-op when the pool has no wheat", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x + 3;
    const ty = HAMLET_CENTER.y + 3;
    // Plough first.
    s = update(s, [{ type: "field", unitIds: [id], action: "plough", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    // Drain wheat from the pool before planting.
    s = { ...s, resources: { ...s.resources, wheat: 0 } };
    s = update(s, [{ type: "field", unitIds: [id], action: "plant", tx, ty }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(fieldAt(s.fields, tx, ty)!.stage).toBe("ploughed"); // unchanged
    expect(s.resources.wheat).toBe(0);
  });

  it("starting wheat matches the §5 spec", () => {
    const s = createInitialState(1);
    expect(s.resources.wheat).toBe(STARTING_WHEAT);
  });
});
