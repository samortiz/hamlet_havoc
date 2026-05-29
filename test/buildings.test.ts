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
  WORKER_SPAWN_TICKS,
} from "../src/config/index.js";
import { isBuilt, makeBuilding } from "../src/game/buildings.js";
import { fieldAt } from "../src/game/fields.js";
import { hexNeighbors } from "../src/game/hex.js";
import { HAMLET_CENTER, isWalkable } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

function firstWorkerId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}

// A mountain a worker can actually build a mine on: it must have at least one
// walkable (non-mountain, non-water) neighbour to stand adjacent to (req §13).
// Pick the one nearest the hamlet so the worker can reach it.
function findMountain(s: GameState): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] !== "mountain") continue;
      if (!hexNeighbors(x, y).some((n) => isWalkable(s.map, n.x, n.y))) continue;
      const d = (x - HAMLET_CENTER.x) ** 2 + (y - HAMLET_CENTER.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  if (!best) throw new Error("no reachable mountain tile");
  return best;
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

  it("resumes an interrupted build with resumeBuild (req §7.1)", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const tx = HAMLET_CENTER.x + 1;
    const ty = HAMLET_CENTER.y + 3;
    s = { ...s, resources: { ...s.resources, wood: 10, wheat: 10 } };

    s = update(s, [{ type: "build", unitIds: [id], kind: "house", tx, ty }], 1);
    const house = Object.values(s.buildings).find((b) => b.x === tx && b.y === ty)!;

    // Build a little, then interrupt the worker before completion.
    s = update(s, [], TICKS_PER_SECOND * 5);
    s = update(s, [{ type: "cancel", unitIds: [id] }], 1);
    const stalled = s.buildings[house.id].progress;
    expect(isBuilt(s.buildings[house.id])).toBe(false);
    expect(stalled).toBeGreaterThan(0);

    // With no builder, progress does not advance.
    s = update(s, [], TICKS_PER_SECOND * 5);
    expect(s.buildings[house.id].progress).toBe(stalled);

    // Resume with the same worker and let it finish.
    s = update(s, [{ type: "resumeBuild", unitIds: [id], buildingId: house.id }], 1);
    s = update(s, [], TICKS_PER_SECOND * 30);
    expect(isBuilt(s.buildings[house.id])).toBe(true);
  });

  it("resumeBuild does nothing on an already-completed building", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const mainHall = Object.values(s.buildings).find((b) => b.kind === "mainHall")!;
    // Main Hall starts complete; resuming it must be a no-op (no idle thrash).
    s = update(s, [{ type: "resumeBuild", unitIds: [id], buildingId: mainHall.id }], 1);
    expect(s.units[id].order.type).toBe("idle");
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

  it("a mountain blocks movement until its mine is built, then is walkable (req §13)", () => {
    let s = createInitialState(2024);
    const id = firstWorkerId(s);
    const m = findMountain(s);
    // Stock wood for the mine + plenty of food so the worker survives the
    // season-boundary upkeep crossed while building (SECONDS_PER_SEASON = 60).
    s = { ...s, resources: { ...s.resources, wood: 10, meat: 99, wheat: 99 } };

    // Ordering a move onto the bare mountain finds no path → unit stays idle.
    s = update(s, [{ type: "moveUnits", unitIds: [id], tx: m.x, ty: m.y }], 1);
    expect(s.units[id].order.type).toBe("idle");

    // Build the mine (worker stands adjacent), then the mountain opens up.
    s = update(s, [{ type: "build", unitIds: [id], kind: "mine", tx: m.x, ty: m.y }], 1);
    s = update(s, [], TICKS_PER_SECOND * 60);
    expect(isBuilt(Object.values(s.buildings).find((b) => b.x === m.x && b.y === m.y)!)).toBe(true);

    // Now a move onto the mined mountain succeeds and the worker (left adjacent
    // by the build) arrives on the tile.
    s = update(s, [{ type: "moveUnits", unitIds: [id], tx: m.x, ty: m.y }], 1);
    expect(s.units[id].order.type).not.toBe("idle");
    s = update(s, [], TICKS_PER_SECOND * 5);
    expect(Math.round(s.units[id].x)).toBe(m.x);
    expect(Math.round(s.units[id].y)).toBe(m.y);
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
      // meat:99 keeps the smithy operator fed across season-end upkeep (§6.3).
      resources: { ...s.resources, wood: 50, wheat: 10, stone: 10, iron: 20, meat: 99 },
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
      // meat:99 keeps the trainee fed across season-end upkeep (§6.3).
      resources: { ...s.resources, wood: 20, wheat: 10, stone: 10, iron: 10, meat: 99 },
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
      equipped: { sword: false, shield: false },
      horseHp: 0,
      attackCooldown: 0,
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
          spawning: false,
          spawnProgress: 0,
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

describe("Main Hall worker production (T5)", () => {
  const mainHallId = (s: GameState) => buildingsOfKind(s, "mainHall")[0];
  const workerCount = (s: GameState) =>
    Object.values(s.units).filter((u) => u.kind === "worker").length;
  // The starting hamlet runs at its 4-worker housing cap (2 Houses × 2), so add
  // a completed House to open a slot the new worker can occupy (§7.4).
  const SPARE_HOUSE = 8000;
  const withSpareHousing = (s: GameState): GameState => ({
    ...s,
    buildings: {
      ...s.buildings,
      [SPARE_HOUSE]: makeBuilding(SPARE_HOUSE, "house", HAMLET_CENTER.x, HAMLET_CENTER.y + 6, { built: true }),
    },
  });

  it("raises a new worker after WORKER_SPAWN_TICKS, for free", () => {
    let s = withSpareHousing(createInitialState(2024));
    const hall = mainHallId(s);
    const before = workerCount(s);
    const resBefore = { ...s.resources };

    s = update(s, [{ type: "spawnWorker", buildingId: hall }], 1);
    expect(s.buildings[hall].spawning).toBe(true);
    expect(workerCount(s)).toBe(before); // not done yet

    s = update(s, [], WORKER_SPAWN_TICKS);
    expect(workerCount(s)).toBe(before + 1);
    expect(s.buildings[hall].spawning).toBe(false);
    expect(s.buildings[hall].spawnProgress).toBe(0);
    // Free: no resources were spent.
    expect(s.resources).toEqual(resBefore);
    // The fresh worker is idle and standing somewhere walkable, not inside.
    const fresh = Object.values(s.units).find((u) => u.kind === "worker" && u.order.type === "idle" && u.insideBuildingId === null);
    expect(fresh).toBeTruthy();
  });

  it("refuses to start when worker housing is full (req §7.4)", () => {
    let s = createInitialState(2024); // 4 workers at a cap of 4
    const hall = mainHallId(s);
    s = update(s, [{ type: "spawnWorker", buildingId: hall }], 1);
    expect(s.buildings[hall].spawning).toBe(false);
    expect(s.buildings[hall].spawnProgress).toBe(0);
  });

  it("a second spawnWorker is ignored while one is already in production", () => {
    let s = withSpareHousing(createInitialState(2024));
    const hall = mainHallId(s);
    s = update(s, [{ type: "spawnWorker", buildingId: hall }], 5);
    const progress = s.buildings[hall].spawnProgress;
    // Re-issuing must not restart the timer.
    s = update(s, [{ type: "spawnWorker", buildingId: hall }], 1);
    expect(s.buildings[hall].spawnProgress).toBeGreaterThan(progress);
  });

  it("stalls at the cap when housing fills mid-production, then finishes once a slot frees (req §7.4)", () => {
    let s = withSpareHousing(createInitialState(2024));
    const hall = mainHallId(s);
    const before = workerCount(s);

    s = update(s, [{ type: "spawnWorker", buildingId: hall }], 1);
    // Pull the spare House back out → housing full again before the timer ends.
    s = update(s, [{ type: "demolish", buildingId: SPARE_HOUSE }], 1);
    s = update(s, [], WORKER_SPAWN_TICKS);
    expect(workerCount(s)).toBe(before); // stalled, no worker
    expect(s.buildings[hall].spawning).toBe(true);
    expect(s.buildings[hall].spawnProgress).toBe(WORKER_SPAWN_TICKS);

    // Open a slot and it completes on the next step.
    s = withSpareHousing(s);
    s = update(s, [], 1);
    expect(workerCount(s)).toBe(before + 1);
    expect(s.buildings[hall].spawning).toBe(false);
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
