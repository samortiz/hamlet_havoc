// T9 — Hall/storage load-unload interface. Headless sim tests for moving goods
// between a unit's inventory and the hamlet's shared resource pool via a built
// storage building the unit stands on or beside.

import { describe, expect, it } from "vitest";
import { WORKER_CARRY_CAP } from "../src/config/index.js";
import { hexNeighbors } from "../src/game/hex.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { storageCapacity } from "../src/game/buildings.js";
import { update } from "../src/game/update.js";
import type { Unit } from "../src/game/units.js";

function firstUnitId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}
function mainHallId(s: GameState): number {
  for (const [id, b] of Object.entries(s.buildings)) {
    if (b.kind === "mainHall") return Number(id);
  }
  throw new Error("no main hall");
}
function setUnit(s: GameState, id: number, patch: Partial<Unit>): GameState {
  return { ...s, units: { ...s.units, [id]: { ...s.units[id], ...patch } } };
}

describe("hall interface — unloading (T9)", () => {
  it("stores a worker's goods into the hamlet pool when standing on the hall", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, carrying: { wood: 5 } });
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "wood", amount: 5, toStorage: true }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(0);
    expect(s.resources.wood).toBe(5);
  });

  it("works from a tile beside the hall, too", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    const beside = hexNeighbors(HAMLET_CENTER.x, HAMLET_CENTER.y)[0];
    s = setUnit(s, id, { x: beside.x, y: beside.y, carrying: { stone: 2 } });
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "stone", amount: 2, toStorage: true }], 1);

    expect(s.units[id].carrying.stone ?? 0).toBe(0);
    expect(s.resources.stone).toBe(2);
  });

  it("clamps a deposit to the pool's free space (respects the storage cap)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    const cap = storageCapacity(s.buildings);
    // Fill the pool to one short of capacity, then try to unload 5 wood.
    s = { ...s, resources: { ...s.resources, hay: cap - 1, wheat: 0 } };
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, carrying: { wood: 5 } });
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "wood", amount: 5, toStorage: true }], 1);

    expect(s.resources.wood).toBe(1); // only one slot was free
    expect(s.units[id].carrying.wood ?? 0).toBe(4);
  });
});

describe("hall interface — loading (T9)", () => {
  it("loads goods from the pool onto a worker, clamped to carry capacity", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    s = { ...s, resources: { ...s.resources, wheat: 0, wood: 30 } };
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, carrying: {} });
    // Ask for far more than the worker can carry.
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "wood", amount: 99, toStorage: false }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(WORKER_CARRY_CAP);
    expect(s.resources.wood).toBe(30 - WORKER_CARRY_CAP);
  });

  it("clamps loading to what the pool actually holds", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    s = { ...s, resources: { ...s.resources, wheat: 0, meat: 2 } };
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, carrying: {} });
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "meat", amount: 5, toStorage: false }], 1);

    expect(s.units[id].carrying.meat ?? 0).toBe(2);
    expect(s.resources.meat).toBe(0);
  });
});

describe("hall interface — guards (T9)", () => {
  it("ignores transfers when the unit is not on or beside the building", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const hall = mainHallId(s);
    // Two tiles away from the hall — not adjacent.
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y + 2, carrying: { wood: 3 } });
    s = update(s, [{ type: "hallStore", unitId: id, buildingId: hall, resource: "wood", amount: 3, toStorage: true }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(3);
    expect(s.resources.wood).toBe(0);
  });
});
