// Horse dismount / mount lifecycle (req §9). A dismounted horse becomes a
// riderless entity that walks to the nearest Stables and parks; a unit can then
// mount it again, reclaiming its buffer HP. The hamlet's total horse count (and
// so its stable usage) is conserved across both.

import { describe, expect, it } from "vitest";
import { HORSE_BONUS_HP } from "../src/config/index.js";
import { makeField } from "../src/game/fields.js";
import { HAMLET_CENTER } from "../src/game/map.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";
import { hasHorse, type Unit } from "../src/game/units.js";

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
// Plant a mature Stables at a grass tile in the hamlet clearing and return both
// the new state and the tile it sits on.
function withStablesAt(s: GameState, dx: number, dy: number): { s: GameState; tile: { x: number; y: number } } {
  const id = s.nextEntityId;
  const tile = { x: HAMLET_CENTER.x + dx, y: HAMLET_CENTER.y + dy };
  const fields = { ...s.fields, [id]: { ...makeField(id, tile.x, tile.y, "stables"), stage: "stablesMature" as const } };
  return { s: { ...s, nextEntityId: id + 1, fields }, tile };
}

describe("horse dismount & mount (req §9)", () => {
  it("dismount spawns a riderless horse that walks to the Stables and parks", () => {
    let s = createInitialState(2024);
    const built = withStablesAt(s, 3, 0);
    s = built.s;
    const id = firstUnitId(s);
    // Mounted unit standing a few tiles from the Stables.
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, horseHp: HORSE_BONUS_HP });

    s = update(s, [{ type: "dismount", unitIds: [id] }], 1);
    // The rider loses the horse immediately; a riderless horse now exists.
    expect(hasHorse(s.units[id])).toBe(false);
    expect(Object.keys(s.horses).length).toBe(1);
    const horse0 = Object.values(s.horses)[0];
    expect(horse0.hp).toBe(HORSE_BONUS_HP); // buffer HP preserved

    // Let it trot to the Stables.
    s = advance(s, 120);
    const horse = Object.values(s.horses)[0];
    expect(horse.stabled).toBe(true);
    expect({ x: horse.x, y: horse.y }).toEqual(built.tile);
  });

  it("a unit can mount a parked horse, reclaiming its buffer HP", () => {
    let s = createInitialState(7);
    const built = withStablesAt(s, 3, 0);
    s = built.s;
    const id = firstUnitId(s);
    s = setUnit(s, id, { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, horseHp: HORSE_BONUS_HP });
    s = update(s, [{ type: "dismount", unitIds: [id] }], 1);
    s = advance(s, 120); // horse parks at the Stables
    expect(Object.values(s.horses)[0].stabled).toBe(true);

    s = update(s, [{ type: "mount", unitIds: [id] }], 1);
    s = advance(s, 120); // walk over and climb on
    expect(hasHorse(s.units[id])).toBe(true);
    expect(s.units[id].horseHp).toBe(HORSE_BONUS_HP);
    expect(Object.keys(s.horses).length).toBe(0); // horse absorbed back into the rider
  });

  it("a riderless horse still counts against stable capacity (req §9)", () => {
    // Capacity 2. One mounted + one dismounted (riderless) horse fills both
    // slots, so a third unit cannot buy a horse at town.
    let s = createInitialState(2024);
    const built = withStablesAt(s, 3, 0);
    s = built.s;
    const ids = Object.keys(s.units).map(Number);
    s = setUnit(s, ids[0], { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, horseHp: HORSE_BONUS_HP });
    s = setUnit(s, ids[1], { x: HAMLET_CENTER.x, y: HAMLET_CENTER.y, horseHp: HORSE_BONUS_HP });
    // Dismount one — it becomes a riderless horse but still occupies a slot.
    s = update(s, [{ type: "dismount", unitIds: [ids[0]] }], 1);
    expect(Object.keys(s.horses).length).toBe(1);

    const buyer = ids[2];
    s = setUnit(s, buyer, { x: s.town.x, y: s.town.y, horseHp: 0, carrying: { meat: 4 } });
    s = update(s, [{ type: "trade", unitIds: [buyer], sell: {}, buy: {}, buyHorse: true }], 1);
    s = advance(s, 60);
    expect(hasHorse(s.units[buyer])).toBe(false); // both slots taken
  });
});
