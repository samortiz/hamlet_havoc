// Town & Horses (req §9, §18). Headless sim tests for the marketplace
// (placement, value-based trade with change, horse purchase) and mounts (carry
// bonus, double speed, buffer HP, hay-field stable capacity).

import { describe, expect, it } from "vitest";
import {
  HAMLET_CLEARING_RADIUS,
  HORSE_BONUS_HP,
  HORSE_CARRY_BONUS,
  TICKS_PER_SEASON,
  WORKER_CARRY_CAP,
} from "../src/config/index.js";
import { makeField } from "../src/game/fields.js";
import { hexDistance, hexNeighbors } from "../src/game/hex.js";
import { HAMLET_CENTER, isWalkable, tileAt } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";
import { carryCap, hasHorse, type Unit } from "../src/game/units.js";

function advance(s: GameState, ticks: number): GameState {
  for (let i = 0; i < ticks; i++) s = update(s, [], 1);
  return s;
}
function firstUnitId(s: GameState): number {
  return Number(Object.keys(s.units)[0]);
}
function setUnit(s: GameState, id: number, patch: Partial<Unit>): GameState {
  return { ...s, units: { ...s.units, [id]: { ...s.units[id], ...patch } } };
}
// A mature hay field stables 2 horses (req §9). Horse purchases are blocked
// without free stable capacity, so seed `n` fields' worth of slots.
function withHayFields(s: GameState, n = 1): GameState {
  const fields = { ...s.fields };
  let nextEntityId = s.nextEntityId;
  for (let i = 0; i < n; i++) {
    const id = nextEntityId++;
    fields[id] = { ...makeField(id, HAMLET_CENTER.x + i, HAMLET_CENTER.y, "hay"), stage: "hayMature" };
  }
  return { ...s, nextEntityId, fields };
}
// A walkable tile next to the town, so a trade resolves after a short walk.
function tileByTown(s: GameState): { x: number; y: number } {
  for (const n of hexNeighbors(s.town.x, s.town.y)) {
    if (isWalkable(s.map, n.x, n.y)) return n;
  }
  return s.town;
}

describe("town placement (req §18)", () => {
  it("is a walkable grass/stump tile far from the Main Hall", () => {
    const s = createInitialState(2024);
    expect(isWalkable(s.map, s.town.x, s.town.y)).toBe(true);
    expect(["grass", "stump"]).toContain(tileAt(s.map, s.town.x, s.town.y));
    expect(hexDistance(s.town, HAMLET_CENTER)).toBeGreaterThan(HAMLET_CLEARING_RADIUS);
  });
});

describe("trading (req §18, §8)", () => {
  it("sells resources at value and returns surplus as gold change", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    // 5 meat = 20 value → with no purchase, change is 20 → 2 gold.
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { meat: 5 } });
    s = update(s, [{ type: "trade", unitIds: [id], sell: { meat: 5 }, buy: {}, buyHorse: false }], 1);
    s = advance(s, 60);

    const u = s.units[id];
    expect(u.order.type).toBe("idle");
    expect(u.carrying.meat ?? 0).toBe(0);
    expect(u.carrying.gold ?? 0).toBe(2);
  });

  it("pays a sub-coin remainder in wood and wheat change", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    // 5 wheat = 10 value, buy 1 stone (3) → surplus 7 → 1 wood (3) + 2 wheat (4).
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { wheat: 5 } });
    s = update(s, [{ type: "trade", unitIds: [id], sell: { wheat: 5 }, buy: { stone: 1 }, buyHorse: false }], 1);
    s = advance(s, 60);

    const u = s.units[id];
    expect(u.carrying.stone ?? 0).toBe(1);
    expect(u.carrying.gold ?? 0).toBe(0);
    expect(u.carrying.wood ?? 0).toBe(1);
    expect(u.carrying.wheat ?? 0).toBe(2);
  });

  it("forfeits an indivisible remainder of exactly 1", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    // 2 wheat = 4 value, buy 1 wood (3) → surplus 1, which no resource can pay.
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { wheat: 2 } });
    s = update(s, [{ type: "trade", unitIds: [id], sell: { wheat: 2 }, buy: { wood: 1 }, buyHorse: false }], 1);
    s = advance(s, 60);

    const u = s.units[id];
    expect(u.carrying.wood ?? 0).toBe(1);
    expect(u.carrying.wheat ?? 0).toBe(0);
    expect(u.carrying.gold ?? 0).toBe(0);
  });

  it("refuses a trade the unit cannot pay for", () => {
    let s = createInitialState(2024);
    s = withHayFields(s); // stable capacity available, so affordability is what bites
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { wheat: 1 } }); // value 2
    s = update(s, [{ type: "trade", unitIds: [id], sell: { wheat: 1 }, buy: {}, buyHorse: true }], 1);
    s = advance(s, 60);

    const u = s.units[id];
    expect(hasHorse(u)).toBe(false); // couldn't afford the 20-value horse
    expect(u.carrying.wheat ?? 0).toBe(1); // inventory untouched
  });
});

describe("town interface — storage transfers (req §18)", () => {
  it("moves goods from the unit into town storage (free, off the hamlet cap)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: { wood: 3 } });
    s = update(s, [{ type: "townStore", unitId: id, resource: "wood", amount: 3, toStorage: true }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(0);
    expect(s.townStorage.wood).toBe(3);
    // Stored goods never touched the hamlet resource pool.
    expect(s.resources.wood).toBe(0);
  });

  it("takes goods from town storage into the unit, clamped to carry capacity", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = { ...s, townStorage: { ...s.townStorage, wheat: 99 } };
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: {} });
    // Asking for 99 but the worker only has WORKER_CARRY_CAP free slots.
    s = update(s, [{ type: "townStore", unitId: id, resource: "wheat", amount: 99, toStorage: false }], 1);

    expect(s.units[id].carrying.wheat ?? 0).toBe(WORKER_CARRY_CAP);
    expect(s.townStorage.wheat).toBe(99 - WORKER_CARRY_CAP);
  });

  it("ignores transfers when the unit is nowhere near town", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, carrying: { wood: 2 } });
    s = update(s, [{ type: "townStore", unitId: id, resource: "wood", amount: 2, toStorage: true }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(2);
    expect(s.townStorage.wood).toBe(0);
  });
});

describe("town interface — value-checked trades (req §18)", () => {
  it("buys a cart when the offered goods are worth enough", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    // Offer 2 wheat (value 4) to buy 1 stone (value 4): exact, accepted.
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: { wheat: 2 } });
    s = update(s, [{
      type: "townTrade",
      unitId: id,
      cart: { stone: 1 },
      buyHorse: false,
      offerUnit: { wheat: 2 },
      offerStorage: {},
    }], 1);

    const u = s.units[id];
    expect(u.carrying.stone ?? 0).toBe(1);
    expect(u.carrying.wheat ?? 0).toBe(0);
  });

  it("rejects a trade whose offer is worth too little (nothing changes)", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: { wheat: 1 } }); // value 2
    s = { ...s, townStorage: { ...s.townStorage, wood: 5 } };
    s = update(s, [{
      type: "townTrade",
      unitId: id,
      cart: { meat: 1 }, // value 4
      buyHorse: false,
      offerUnit: { wheat: 1 },
      offerStorage: {},
    }], 1);

    expect(s.units[id].carrying.meat ?? 0).toBe(0); // not bought
    expect(s.units[id].carrying.wheat ?? 0).toBe(1); // offer untouched
    expect(s.townStorage.wood).toBe(5); // storage untouched
  });

  it("returns whole-coin surplus value to town storage as gold change", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    // Offer 3 meat (value 12) for 1 wheat (value 2): 10 surplus → 1 gold change.
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: { meat: 3 } });
    s = update(s, [{
      type: "townTrade",
      unitId: id,
      cart: { wheat: 1 },
      buyHorse: false,
      offerUnit: { meat: 3 },
      offerStorage: {},
    }], 1);

    expect(s.units[id].carrying.wheat ?? 0).toBe(1);
    expect(s.units[id].carrying.meat ?? 0).toBe(0);
    expect(s.townStorage.gold).toBe(1); // 10 surplus value = 1 gold
  });

  it("can buy a horse paying entirely from town storage", () => {
    let s = createInitialState(2024);
    s = withHayFields(s);
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: {} });
    s = { ...s, townStorage: { ...s.townStorage, gold: 2 } }; // 2 gold = 20 value
    s = update(s, [{
      type: "townTrade",
      unitId: id,
      cart: {},
      buyHorse: true,
      offerUnit: {},
      offerStorage: { gold: 2 },
    }], 1);

    expect(hasHorse(s.units[id])).toBe(true);
    expect(s.townStorage.gold).toBe(0);
  });

  it("rejects a purchase that would overflow the unit's carry capacity", () => {
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    // Pay from storage (frees no slots) and try to load more than fits.
    s = setUnit(s, id, { x: s.town.x, y: s.town.y, carrying: {} });
    s = { ...s, townStorage: { ...s.townStorage, gold: 99 } };
    const cart = { wood: WORKER_CARRY_CAP + 1 };
    s = update(s, [{
      type: "townTrade",
      unitId: id,
      cart,
      buyHorse: false,
      offerUnit: {},
      offerStorage: { gold: 99 },
    }], 1);

    expect(s.units[id].carrying.wood ?? 0).toBe(0); // rejected
    expect(s.townStorage.gold).toBe(99); // offer untouched
  });
});

describe("horses (req §9)", () => {
  it("a unit can buy a horse at town by selling carried goods", () => {
    let s = createInitialState(2024);
    s = withHayFields(s);
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { meat: 5 } }); // 20 value
    s = update(s, [{ type: "trade", unitIds: [id], sell: { meat: 5 }, buy: {}, buyHorse: true }], 1);
    s = advance(s, 60);

    const u = s.units[id];
    expect(hasHorse(u)).toBe(true);
    expect(u.horseHp).toBe(HORSE_BONUS_HP);
    expect(u.carrying.meat ?? 0).toBe(0); // spent exactly on the horse
  });

  it("a horse adds 10 buffer HP (req §9)", () => {
    expect(HORSE_BONUS_HP).toBe(10);
  });

  it("cannot buy a horse with no free hay-field stable capacity (req §9)", () => {
    // No hay fields → no stable → purchase is blocked even when affordable.
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    const spot = tileByTown(s);
    s = setUnit(s, id, { x: spot.x, y: spot.y, carrying: { meat: 4 } }); // 20 value
    s = update(s, [{ type: "trade", unitIds: [id], sell: {}, buy: {}, buyHorse: true }], 1);
    s = advance(s, 60);
    expect(hasHorse(s.units[id])).toBe(false);
    expect(s.units[id].carrying.meat ?? 0).toBe(4); // nothing sold, no horse
  });

  it("blocks the horse once every stable slot is taken (req §9)", () => {
    // One mature hay field stables 2 horses. With two mounted units already, a
    // third unit cannot buy a horse.
    let s = createInitialState(2024);
    s = withHayFields(s, 1); // capacity 2
    const ids = Object.keys(s.units).map(Number);
    s = setUnit(s, ids[0], { horseHp: HORSE_BONUS_HP });
    s = setUnit(s, ids[1], { horseHp: HORSE_BONUS_HP });
    const buyer = ids[2];
    const spot = tileByTown(s);
    s = setUnit(s, buyer, { x: spot.x, y: spot.y, horseHp: 0, carrying: { meat: 4 } });
    s = update(s, [{ type: "trade", unitIds: [buyer], sell: {}, buy: {}, buyHorse: true }], 1);
    s = advance(s, 60);
    expect(hasHorse(s.units[buyer])).toBe(false);
  });

  it("a mount adds carry capacity", () => {
    const s = createInitialState(1);
    const u = s.units[firstUnitId(s)];
    expect(carryCap(u)).toBe(WORKER_CARRY_CAP);
    expect(carryCap({ ...u, horseHp: HORSE_BONUS_HP })).toBe(WORKER_CARRY_CAP + HORSE_CARRY_BONUS);
    // Each equipped item still costs a slot, even mounted.
    expect(carryCap({ ...u, horseHp: HORSE_BONUS_HP, equipped: { sword: true, shield: false } }))
      .toBe(WORKER_CARRY_CAP + HORSE_CARRY_BONUS - 1);
  });

  it("a mount doubles travel speed", () => {
    let s = createInitialState(2024);
    const ids = Object.keys(s.units).map(Number);
    const foot = ids[0];
    const rider = ids[1];
    const start = { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y };
    s = setUnit(s, foot, { x: start.x, y: start.y, horseHp: 0 });
    s = setUnit(s, rider, { x: start.x, y: start.y, horseHp: HORSE_BONUS_HP });
    // Walk both to the far town along the same path.
    s = update(s, [{ type: "moveUnits", unitIds: [foot, rider], tx: s.town.x, ty: s.town.y }], 1);
    s = advance(s, 60); // 2 sec

    const dist = (u: Unit) => Math.hypot(u.x - start.x, u.y - start.y);
    const footDist = dist(s.units[foot]);
    const riderDist = dist(s.units[rider]);
    expect(footDist).toBeGreaterThan(0);
    expect(riderDist).toBeGreaterThan(footDist * 1.5); // ~2× before path bends
  });

  it("horses have no per-season upkeep — a horse survives a starved season (§9)", () => {
    // No wheat at all, workers fed by meat: the horse is never billed and
    // keeps its buffer HP across the season boundary.
    let s = createInitialState(2024);
    const id = firstUnitId(s);
    s = { ...s, resources: { ...s.resources, wheat: 0, meat: 999 } };
    s = setUnit(s, id, { horseHp: HORSE_BONUS_HP });
    s = advance(s, TICKS_PER_SEASON);
    expect(s.units[id].horseHp).toBe(HORSE_BONUS_HP);
  });
});
