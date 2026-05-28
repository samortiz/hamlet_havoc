// M3 — construction system tests (req §7, §7.1, §7.2, §7.3, §7.4). Each test
// drives the headless sim through a full lifecycle (place → build → done; place
// → damage → repair; place → demolish; smithy crafting; barracks training and
// the housing-cap gate). Mechanics live in sim tests; the e2e suite only
// confirms the page boots and the wiring is intact.

import { describe, expect, it } from "vitest";
import {
  BUILD_TICKS,
  CRAFT_TICKS,
  HAY_FIELD_BUILD_TICKS,
  TICKS_PER_SECOND,
  TRAIN_TICKS,
} from "../src/config/index.js";
import { isBuilt } from "../src/game/buildings.js";
import { fieldAt } from "../src/game/fields.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstWorkerId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}

function findMountain(s: GameState): { x: number; y: number } {
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] === "mountain") return { x, y };
    }
  }
  throw new Error("no mountain tile");
}

function buildingsOfKind(s: GameState, kind: string): number[] {
  return Object.values(s.buildings).filter((b) => b.kind === kind).map((b) => b.id);
}

describe("construction lifecycle (req §7.1)", () => {
  it("places a House and a worker builds it to completion", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x + 1;
    const ty = HAMLET_CENTER.y + 3;
    // Stockpile wood + wheat so the placement command can pay the cost.
    s = { ...s, resources: { ...s.resources, wood: 10, wheat: 10 } };

    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx, ty }], 1);
    const newHouse = Object.values(s.buildings).find((b) => b.x === tx && b.y === ty)!;
    expect(newHouse.kind).toBe("house");
    expect(isBuilt(newHouse)).toBe(false);
    expect(s.resources.wood).toBe(10 - 3);
    expect(s.resources.wheat).toBe(10 - 2);

    // Walk + build (req §7.1). 20-sec build + small movement margin.
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(isBuilt(s.buildings[newHouse.id])).toBe(true);
  });

  it("rejects placement on an invalid tile (water) and refunds nothing", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    s = { ...s, resources: { ...s.resources, wood: 10, wheat: 10 } };
    // Find a water tile.
    let water: { x: number; y: number } | null = null;
    for (let y = 0; y < s.map.height && !water; y++) {
      for (let x = 0; x < s.map.width; x++) {
        if (s.map.tiles[y * s.map.width + x] === "water") {
          water = { x, y };
          break;
        }
      }
    }
    expect(water).not.toBeNull();
    const before = { ...s.resources };
    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx: water!.x, ty: water!.y }], 1);
    expect(s.resources).toEqual(before); // not deducted
    // No new building was created at that tile.
    expect(Object.values(s.buildings).some((b) => b.x === water!.x && b.y === water!.y)).toBe(false);
  });

  it("rejects placement when the player cannot pay the cost", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    // Drain wood so we can't afford a house (cost 3 wood + 2 wheat).
    s = { ...s, resources: { ...s.resources, wood: 0, wheat: 5 } };
    const tx = HAMLET_CENTER.x + 1;
    const ty = HAMLET_CENTER.y + 3;
    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx, ty }], 1);
    expect(Object.values(s.buildings).some((b) => b.x === tx && b.y === ty)).toBe(false);
    expect(s.resources.wheat).toBe(5); // untouched
  });
});

describe("mine placement + type rolling (req §13)", () => {
  it("a built mine rolls a stone/iron/gold type and enables mining", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const m = findMountain(s);
    s = { ...s, resources: { ...s.resources, wood: 10 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "mine", tx: m.x, ty: m.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 60); // generous time to walk + build
    const mine = Object.values(s.buildings).find((b) => b.x === m.x && b.y === m.y)!;
    expect(isBuilt(mine)).toBe(true);
    expect(s.map.mineType[m.y * s.map.width + m.x]).toMatch(/stone|iron|gold/);
  });
});

describe("repair (req §7.1)", () => {
  it("a damaged building is restored to full HP by a worker", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    // Damage one of the starting houses to 1 HP.
    const houseId = buildingsOfKind(s, "house")[0];
    const damaged = { ...s.buildings[houseId], hp: 1 };
    s = { ...s, buildings: { ...s.buildings, [houseId]: damaged } };

    s = update(s, [{ type: "repair", buildingId: houseId, unitIds: [id] }], 1);
    s = update(s, [], TICKS_PER_SECOND * 40); // 20-sec build window + walk

    expect(s.buildings[houseId].hp).toBe(s.buildings[houseId].maxHp);
  });
});

describe("demolish (req §7.1)", () => {
  it("removes a building, ejects its occupant, and cancels build orders", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x + 1;
    const ty = HAMLET_CENTER.y + 3;
    s = { ...s, resources: { ...s.resources, wood: 10, wheat: 10 } };

    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx, ty }], 1);
    const placed = Object.values(s.buildings).find((b) => b.x === tx && b.y === ty)!;
    s = update(s, [], 5); // start walking
    expect(s.units[id].order.type).toBe("build");

    s = update(s, [{ type: "demolish", buildingId: placed.id }], 1);
    expect(s.buildings[placed.id]).toBeUndefined();
    expect(s.units[id].order.type).toBe("idle");
  });

  it("refuses to demolish the main hall (loss condition, req §16)", () => {
    let s = createInitialState(2024);
    const mh = Object.values(s.buildings).find((b) => b.kind === "mainHall")!;
    s = update(s, [{ type: "demolish", buildingId: mh.id }], 1);
    expect(s.buildings[mh.id]).toBeDefined();
  });
});

describe("smithy crafting (req §7.2)", () => {
  it("a worker stationed in a smithy produces sword + shield items over time", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const sx = HAMLET_CENTER.x + 3;
    const sy = HAMLET_CENTER.y;
    s = {
      ...s,
      resources: { ...s.resources, wood: 50, wheat: 10, stone: 10, iron: 20 },
    };
    s = update(s, [{ type: "build", unitIds: [id], kind: "smithy", tx: sx, ty: sy }], 1);
    s = update(s, [], TICKS_PER_SECOND * 80); // finish smithy (60s) + walk
    const smithy = Object.values(s.buildings).find((b) => b.x === sx && b.y === sy)!;
    expect(isBuilt(smithy)).toBe(true);

    // Start crafting swords.
    s = update(s, [{ type: "craft", unitIds: [id], buildingId: smithy.id, item: "sword" }], 1);
    // Wait long enough for two swords + walk-to-smithy time.
    s = update(s, [], CRAFT_TICKS * 2 + TICKS_PER_SECOND * 20);
    expect(s.equipment.sword).toBeGreaterThanOrEqual(1);
    expect(s.resources.iron).toBeLessThanOrEqual(20 - 2); // at least one sword paid

    // Switch the same operator to shields.
    s = update(s, [{ type: "craft", unitIds: [id], buildingId: smithy.id, item: "shield" }], 1);
    s = update(s, [], CRAFT_TICKS + TICKS_PER_SECOND * 10);
    expect(s.equipment.shield).toBeGreaterThanOrEqual(1);
  });
});

describe("barracks training (req §7.3, §7.4)", () => {
  it("a worker enters a built barracks and emerges as a soldier", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const bx = HAMLET_CENTER.x;
    const by = HAMLET_CENTER.y + 4;
    s = {
      ...s,
      resources: { ...s.resources, wood: 20, wheat: 10, stone: 10, iron: 10 },
    };
    s = update(s, [{ type: "build", unitIds: [id], kind: "barracks", tx: bx, ty: by }], 1);
    s = update(s, [], TICKS_PER_SECOND * 80);
    const barracks = Object.values(s.buildings).find((b) => b.x === bx && b.y === by)!;
    expect(isBuilt(barracks)).toBe(true);

    s = update(s, [{ type: "train", unitIds: [id], buildingId: barracks.id, toKind: "soldier" }], 1);
    s = update(s, [], TRAIN_TICKS + TICKS_PER_SECOND * 10);
    expect(s.units[id].kind).toBe("soldier");
    expect(s.units[id].insideBuildingId).toBeNull();
  });

  it("rejects training when barracks housing is full (req §7.4)", () => {
    let s = createInitialState(2024);
    // Promote all 4 starting workers to soldiers (filling one barracks at
    // cap=4), then add a 5th worker to attempt training. The training command
    // must be refused because no destination slot is free.
    const ids = Object.keys(s.units).map(Number);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const promoted: typeof s.units = { ...s.units };
    for (let i = 0; i < 4; i++) {
      promoted[ids[i]] = { ...promoted[ids[i]], kind: "soldier" };
    }
    const extraWorkerId = 9001;
    promoted[extraWorkerId] = {
      id: extraWorkerId,
      kind: "worker",
      x: HAMLET_CENTER.x,
      y: HAMLET_CENTER.y + 1,
      hp: 2,
      carrying: {},
      insideBuildingId: null,
      order: { type: "idle" },
    };

    s = { ...s, units: promoted };
    const bx = HAMLET_CENTER.x;
    const by = HAMLET_CENTER.y + 4;
    s = {
      ...s,
      buildings: {
        ...s.buildings,
        99: {
          id: 99,
          kind: "barracks",
          x: bx,
          y: by,
          hp: 80,
          maxHp: 80,
          progress: 99999,
          occupantId: null,
          craftItem: null,
          craftProgress: 0,
          trainTo: null,
          trainProgress: 0,
        },
      },
    };

    s = update(s, [{ type: "train", unitIds: [extraWorkerId], buildingId: 99, toKind: "soldier" }], 1);
    expect(s.units[extraWorkerId].order.type).toBe("idle");
    expect(s.units[extraWorkerId].kind).toBe("worker");
  });
});

describe("hay field (req §7)", () => {
  it("places a hay-field-under-construction and matures it", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x;
    const ty = HAMLET_CENTER.y - 3;
    s = { ...s, resources: { ...s.resources, wood: 10 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "hayField", tx, ty }], 1);
    expect(fieldAt(s.fields, tx, ty)?.stage).toBe("hayBuilding");

    s = update(s, [], HAY_FIELD_BUILD_TICKS + TICKS_PER_SECOND * 20);
    expect(fieldAt(s.fields, tx, ty)?.stage).toBe("hayMature");
  });
});

describe("build determinism + serialization", () => {
  it("starting buildings spawn complete (progress = BUILD_TICKS[kind])", () => {
    const s = createInitialState(1);
    for (const b of Object.values(s.buildings)) {
      expect(b.progress).toBe(BUILD_TICKS[b.kind]);
      expect(isBuilt(b)).toBe(true);
    }
  });

  it("a placed under-construction building survives a JSON round-trip", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    s = { ...s, resources: { ...s.resources, wood: 10, wheat: 10 } };
    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx: HAMLET_CENTER.x + 1, ty: HAMLET_CENTER.y + 3 }], 1);
    const restored = JSON.parse(JSON.stringify(s)) as GameState;
    expect(restored).toEqual(s);
  });
});
