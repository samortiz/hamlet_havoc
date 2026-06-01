// End-of-year events (req §16, §21). Headless sim tests driven through the
// real update() step: each event type triggers at the winter→spring boundary and
// resolves; the upcoming event is announced a year ahead; the loss conditions
// (Main Hall destroyed / all workers dead) flip the phase to gameOver.

import { describe, expect, it } from "vitest";
import { TAX_FLAVOUR_COEFFS, TAX_MAX_GOLD_PER_YEAR, TICKS_PER_SECOND, TICKS_PER_YEAR } from "../src/config/index.js";
import {
  chooseUpcomingEvent,
  isMiscGood,
  type EventCategory,
  type TaxFlavour,
  type UpcomingEvent,
} from "../src/game/events.js";
import { resourceTaxGold } from "../src/game/actions.js";
import { makeBuilding, type Building } from "../src/game/buildings.js";
import { emptyPool } from "../src/game/resources.js";
import { createInitialState, type GameState } from "../src/game/state.js";
import { update } from "../src/game/update.js";

// Drop an extra fully-built building into a state (for housing / barn-count
// tests). Uses high ids so it never collides with createInitialState's entities.
function withBuilding(s: GameState, kind: Building["kind"], id: number): GameState {
  return { ...s, buildings: { ...s.buildings, [id]: makeBuilding(id, kind, id, 0, { built: true }) } };
}
const countBuildings = (s: GameState, kind: string) =>
  Object.values(s.buildings).filter((b) => b.kind === kind).length;
const countUnits = (s: GameState, kind: string) =>
  Object.values(s.units).filter((u) => u.kind === kind).length;

// A well-fed hamlet poised on the last tick of winter, with a known upcoming
// event, so the next single step crosses the winter→spring boundary and fires it.
function onYearBoundary(seed: number, upcoming: UpcomingEvent): GameState {
  const s = createInitialState(seed);
  const resources = emptyPool();
  resources.meat = 50;
  resources.wheat = 50;
  resources.gold = 50;
  return {
    ...s,
    tickCount: TICKS_PER_YEAR - 1,
    upcomingEvent: upcoming,
    resources,
  };
}

describe("event selection & announcement (req §16.0, §16.4)", () => {
  it("announces a year-1 event from the initial state", () => {
    const s = createInitialState(123);
    expect(s.phase).toBe("playing");
    expect(s.upcomingEvent).toBeDefined();
    expect(["attack", "tax", "misc"]).toContain(s.upcomingEvent.category);
  });

  it("year 1 is always a good Misc (§16.0)", () => {
    const [, ev] = chooseUpcomingEvent(987, 1, []);
    expect(ev.category).toBe("misc");
    if (ev.category === "misc") expect(isMiscGood(ev.misc)).toBe(true);
  });

  it("follows the deterministic 3-year cadence (§16.0)", () => {
    // Walk the schedule forward year by year, threading the leftover block.
    let rng = 555;
    let schedule: EventCategory[] = [];
    const cats: EventCategory[] = [];
    for (let year = 1; year <= 12; year++) {
      const [next, ev, sched] = chooseUpcomingEvent(rng, year, schedule);
      rng = next;
      schedule = sched;
      cats.push(ev.category);
    }
    // Year 1: a Misc opener. Years 2-3: one Attack + one Tax in some order.
    expect(cats[0]).toBe("misc");
    expect(cats.slice(1, 3).sort()).toEqual(["attack", "tax"]);
    // Each later 3-year block holds one each of misc/tax/attack.
    for (const start of [3, 6, 9]) {
      expect(cats.slice(start, start + 3).sort()).toEqual(["attack", "misc", "tax"]);
    }
  });

  it("only fires at the winter→spring boundary, not mid-year", () => {
    let s = onYearBoundary(1, { category: "tax" });
    s = { ...s, tickCount: 100 }; // nowhere near a year boundary
    s = update(s, [], 1);
    expect(s.phase).toBe("playing");
  });
});

describe("attack event (req §16.1)", () => {
  it("spawns a wave at the boundary without pausing, and rolls into spring", () => {
    let s = onYearBoundary(42, { category: "attack" });
    s = update(s, [], 1); // cross winter→spring
    // An attack is fought live — it never opens the modal phase or an activeEvent.
    expect(s.phase).toBe("playing");
    expect(s.activeEvent).toBeNull();
    expect(Object.keys(s.enemies).length).toBeGreaterThan(0);
    // The year resolves immediately: survival counted and next year announced.
    expect(s.stats.yearsSurvived).toBe(1);
    expect(s.upcomingEvent).toBeDefined();
    // A clickable warning banner was posted for the wave.
    expect(s.notifications.some((n) => n.kind === "enemy")).toBe(true);
  });

  it("does not suspend season time during the attack — the calendar keeps moving", () => {
    let s = onYearBoundary(7, { category: "attack" });
    s = update(s, [], 1);
    const afterTrigger = s.tickCount;
    s = update(s, [], 5); // enemies still alive, but time now keeps advancing
    expect(s.phase).toBe("playing");
    expect(s.tickCount).toBe(afterTrigger + 5);
  });

  it("rolls one of the four flavours and never spawns an empty wave (§16.1)", () => {
    // The flavour is no longer stored in state, but the warning banner names it,
    // so distinct banners stand in for distinct flavours.
    const banners = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      let s = onYearBoundary(seed, { category: "attack" });
      // Year 1 here (boundary at TICKS_PER_YEAR), so the goblin floor is 1.
      s = { ...s, resources: { ...emptyPool(), wheat: 50, meat: 50 } };
      s = update(s, [], 1);
      const note = s.notifications.find((n) => n.kind === "enemy");
      if (note) banners.add(note.message);
      const kinds = Object.values(s.enemies).map((e) => e.kind);
      // A wave is never empty, and with no gold/diamonds no dragon can appear.
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds).not.toContain("dragon");
    }
    // Over many seeds we should see more than one flavour drawn.
    expect(banners.size).toBeGreaterThan(1);
  });

  it("a Goblin/Dragon attack on a diamond hoard spawns a dragon (§16.1)", () => {
    // Only the goblinDragon flavour can spawn a dragon, so its presence in the
    // wave is the tell. Search seeds until one rolls it with 2+ diamonds.
    let sawDragonWave = false;
    for (let seed = 1; seed <= 80 && !sawDragonWave; seed++) {
      let s = onYearBoundary(seed, { category: "attack" });
      s = { ...s, resources: { ...emptyPool(), wheat: 50, meat: 50, diamond: 2 } };
      s = update(s, [], 1);
      const kinds = Object.values(s.enemies).map((e) => e.kind);
      if (kinds.includes("dragon")) {
        expect(kinds).toEqual(["dragon"]);
        sawDragonWave = true;
      }
    }
    expect(sawDragonWave).toBe(true);
  });
});

// Nearest tile of a given type to (fromX, fromY) — to point a worker at a forest.
function nearestTile(s: GameState, type: string, fromX: number, fromY: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < s.map.height; y++) {
    for (let x = 0; x < s.map.width; x++) {
      if (s.map.tiles[y * s.map.width + x] !== type) continue;
      const d = (x - fromX) ** 2 + (y - fromY) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

describe("the Tax/Misc modal fully pauses the world (req §16, §21.1)", () => {
  it("freezes a mid-gather worker while the dialog is open, then resumes it", () => {
    // A well-fed hamlet on the year boundary, with a Tax queued — the modal
    // pauses everything until the player settles it.
    let s = onYearBoundary(777, { category: "tax" });
    const id = Number(Object.keys(s.units)[0]);
    const w = s.units[id];
    const forest = nearestTile(s, "forest", Math.round(w.x), Math.round(w.y))!;
    expect(forest).not.toBeNull();

    // Send the worker chopping; this step also crosses into the event.
    s = update(s, [{ type: "gather", unitIds: [id], tx: forest.x, ty: forest.y }], 1);
    expect(s.phase).toBe("endOfYearEvent");
    expect(s.units[id].order.type).toBe("gather"); // order held, not cancelled

    // Over a long span nothing about the worker or the stockpile changes.
    const before = JSON.stringify({ u: s.units[id], wood: s.resources.wood });
    s = update(s, [], TICKS_PER_SECOND * 60);
    expect(JSON.stringify({ u: s.units[id], wood: s.resources.wood })).toBe(before);
    expect(s.phase).toBe("endOfYearEvent");

    // Settling the tax returns to normal play; the worker resumes and gathers.
    s = update(s, [{ type: "payTax", offerResources: {}, surrenderBuildingIds: [], forfeit: true }], 1);
    expect(s.phase).toBe("playing");
    s = update(s, [], TICKS_PER_SECOND * 50);
    // The stocked food fills storage, so the wood may sit in the worker's hands
    // rather than the pool — either way, chopping it proves work resumed.
    const wood = s.resources.wood + Object.values(s.units).reduce((n, u) => n + (u.carrying.wood ?? 0), 0);
    expect(wood).toBeGreaterThan(0);
  });
});

// The §16.2 demand formula for `flavour`, recomputed from the (pre-tax) state so
// the test cross-checks startTax's flavour-keyed maths end-to-end.
function expectedTaxDemand(s: GameState, flavour: TaxFlavour, year: number): number {
  const c = TAX_FLAVOUR_COEFFS[flavour];
  const r = s.resources;
  let workers = 0;
  let swords = s.equipment.sword;
  let shields = s.equipment.shield;
  let horses = 0;
  for (const u of Object.values(s.units)) {
    if (u.kind === "worker") workers++;
    if (u.equipped.sword) swords++;
    if (u.equipped.shield) shields++;
    if (u.horseHp > 0) horses++;
  }
  const count = (kind: string) =>
    Object.values(s.buildings).filter((b) => b.kind === kind).length;
  let base = 0;
  switch (flavour) {
    case "worker":
      base = (c.perWorker ?? 0) * workers;
      break;
    case "weapon":
      base = (c.perSword ?? 0) * swords + (c.perShield ?? 0) * shields;
      break;
    case "building":
      base =
        (c.perSmithy ?? 0) * count("smithy") +
        (c.perBarn ?? 0) * count("barn") +
        (c.perBarracks ?? 0) * count("barracks");
      break;
    case "housing":
      base = (c.perHouse ?? 0) * count("house");
      break;
    case "animal":
      base = (c.perHorse ?? 0) * horses;
      break;
    case "wealth":
      base = Math.floor(r.gold / (c.goldDivisor ?? 1)) + (c.perDiamond ?? 0) * r.diamond;
      break;
    case "resource":
      base =
        Math.floor(r.wheat / (c.wheatDivisor ?? 1)) +
        Math.floor(r.wood / (c.woodDivisor ?? 1)) +
        Math.floor(r.meat / (c.meatDivisor ?? 1)) +
        Math.floor(r.stone / (c.stoneDivisor ?? 1)) +
        Math.floor(r.iron / (c.ironDivisor ?? 1));
      break;
  }
  return base + c.perYear * year;
}

// The §16.2 formula demand, capped at year × TAX_MAX_GOLD_PER_YEAR (§16.2.1). No
// auto-pay happens any more, so the post-event resources equal the trigger-time
// stats the demand keyed off — `s` is read directly.
function expectedDemand(s: GameState, flavour: TaxFlavour, year: number): number {
  return Math.min(expectedTaxDemand(s, flavour, year), year * TAX_MAX_GOLD_PER_YEAR);
}

describe("tax event (req §16.2, §16.2.1)", () => {
  it("caps the demand, leaves the treasury untouched, and settles when paid", () => {
    const before = onYearBoundary(9, { category: "tax" });
    const goldBefore = before.resources.gold;
    const s = update(before, [], 1);
    expect(s.phase).toBe("endOfYearEvent");
    expect(s.activeEvent?.category).toBe("tax");
    if (s.activeEvent?.category !== "tax") return;
    // Demand matches the §16.2 formula, capped at year × 5 (year 1 at this boundary).
    expect(s.activeEvent.demand).toBe(expectedDemand(s, s.activeEvent.flavour, 1));
    // Nothing is auto-paid — the player chooses what to surrender (§16.2.1).
    expect(s.resources.gold).toBe(goldBefore);

    const demand = s.activeEvent.demand;
    // Gold pays at face value (§16.2.1), so `demand` gold covers the whole demand.
    const done = update(
      s,
      [{ type: "payTax", offerResources: { gold: demand }, surrenderBuildingIds: [], forfeit: false }],
      1,
    );
    expect(done.phase).toBe("playing");
    expect(done.resources.gold).toBe(goldBefore - demand);
    expect(done.upcomingEvent).toBeDefined(); // next year announced
  });

  it("rolls a flavour and matches each capped formula across seeds (§16.2)", () => {
    const seen = new Set<TaxFlavour>();
    for (let seed = 1; seed <= 60; seed++) {
      const before = onYearBoundary(seed, { category: "tax" });
      const s = update(before, [], 1);
      if (s.activeEvent?.category !== "tax") continue;
      seen.add(s.activeEvent.flavour);
      expect(s.activeEvent.demand).toBe(expectedDemand(s, s.activeEvent.flavour, 1));
    }
    expect(seen.size).toBeGreaterThan(1); // not always the same flavour
  });

  it("forfeit settles a tax the hamlet cannot pay", () => {
    let s = onYearBoundary(11, { category: "tax" });
    s = { ...s, resources: emptyPool() }; // broke — gold can't cover, but no upkeep owed either
    // Re-feed so the boundary upkeep doesn't kill the workers and end the game.
    s = { ...s, resources: { ...emptyPool(), wheat: 10 } };
    s = update(s, [], 1);
    expect(s.phase).toBe("endOfYearEvent");
    if (s.activeEvent?.category === "tax") expect(s.activeEvent.demand).toBeGreaterThan(0);

    s = update(s, [{ type: "payTax", offerResources: {}, surrenderBuildingIds: [], forfeit: true }], 1);
    expect(s.phase).toBe("playing");
  });

  // The §16.2.1 conversion table: gold pays face value, diamonds pay double, and
  // every other good pays half of its trade value (all normalised to gold).
  it("prices each good against the §16.2.1 table", () => {
    expect(resourceTaxGold({ gold: 1 })).toBe(1); // 1 gold → 1
    expect(resourceTaxGold({ diamond: 1 })).toBe(10); // 1 diamond → 10 (100% bonus)
    expect(resourceTaxGold({ wheat: 10 })).toBe(1); // 10 wheat → 1
    expect(resourceTaxGold({ wood: 20 })).toBeCloseTo(3); // 20 wood → 3
    expect(resourceTaxGold({ stone: 20 })).toBeCloseTo(3);
    expect(resourceTaxGold({ meat: 5 })).toBe(1); // 5 meat → 1
    expect(resourceTaxGold({ iron: 5 })).toBe(1);
  });

  it("pays a tax with diamonds and overpays without change (§16.2.1)", () => {
    let s = onYearBoundary(4, { category: "tax" });
    s = { ...s, resources: { ...emptyPool(), wheat: 50, meat: 50, diamond: 2 } };
    s = update(s, [], 1);
    expect(s.activeEvent?.category).toBe("tax");
    if (s.activeEvent?.category !== "tax") return;
    // A single diamond (worth 10 gold) clears the capped demand (≤ year 1 × 5 = 5).
    expect(s.activeEvent.demand).toBeLessThanOrEqual(TAX_MAX_GOLD_PER_YEAR);
    const diamondsBefore = s.resources.diamond;
    s = update(
      s,
      [{ type: "payTax", offerResources: { diamond: 1 }, surrenderBuildingIds: [], forfeit: false }],
      1,
    );
    expect(s.phase).toBe("playing");
    // Exactly the one offered diamond is taken — no change is given for the overpayment.
    expect(s.resources.diamond).toBe(diamondsBefore - 1);
  });
});

describe("misc events (req §16.3)", () => {
  it("Crop Blight destroys half the stored wheat, then resolves on acknowledge", () => {
    let s = onYearBoundary(5, { category: "misc", misc: "cropBlight" });
    s = { ...s, resources: { ...s.resources, wheat: 10 } };
    s = update(s, [], 1);
    expect(s.phase).toBe("endOfYearEvent");
    expect(s.activeEvent?.category).toBe("misc");
    expect(s.resources.wheat).toBe(5); // 50% destroyed

    s = update(s, [{ type: "acknowledgeEvent" }], 1);
    expect(s.phase).toBe("playing");
  });

  it("Festival speeds the year, then expires at the next year-end", () => {
    let s = onYearBoundary(6, { category: "misc", misc: "festival" });
    s = update(s, [], 1);
    expect(s.eventMods.festival).toBe(true);
    s = update(s, [{ type: "acknowledgeEvent" }], 1);
    expect(s.phase).toBe("playing");
    expect(s.eventMods.festival).toBe(true); // active through the coming year
  });
});

// New §16.3 library (item 31). Each test pins the boundary upkeep by feeding the
// 4 starting workers exactly 2 meat (ceil(4/2)), which is fully consumed, so the
// other resource under test is untouched before the event fires.
describe("misc events — new §16.3 library (item 31)", () => {
  function fire(seed: number, misc: GameState["upcomingEvent"], extra: Partial<GameState> = {}): GameState {
    let s = onYearBoundary(seed, misc);
    s = { ...s, ...extra };
    return update(s, [], 1);
  }

  it("Storage Thief steals 50% of the one stored resource", () => {
    const s = fire(3, { category: "misc", misc: "storageThief" }, {
      resources: { ...emptyPool(), meat: 2, wood: 30 },
    });
    expect(s.resources.wood).toBe(15); // ceil(30 * 0.5) stolen
  });

  it("Blight spoils 25% wheat and 25% meat", () => {
    const s = fire(4, { category: "misc", misc: "blight" }, {
      resources: { ...emptyPool(), meat: 10, wheat: 20 },
    });
    // 2 meat pays upkeep → 8 left; −25% wheat (20→15), −25% meat (8→6).
    expect(s.resources.wheat).toBe(15);
    expect(s.resources.meat).toBe(6);
  });

  it("Wood Boon adds 50% wood, capped at storage", () => {
    const s = fire(5, { category: "misc", misc: "woodBoon" }, {
      resources: { ...emptyPool(), meat: 2, wood: 10 },
    });
    expect(s.resources.wood).toBe(15); // +floor? ceil(10*0.5)=5 → 15
  });

  it("Termites eat 75% of wood and salvage 1 meat per 5 wood", () => {
    const s = fire(6, { category: "misc", misc: "termites" }, {
      resources: { ...emptyPool(), meat: 2, wood: 20 },
    });
    expect(s.resources.wood).toBe(5); // lose floor(20*0.75)=15
    expect(s.resources.meat).toBe(4); // floor(20/5)=4 salvaged (meat upkeep already paid)
  });

  it("Midas Touch turns meat into gold then loses 25% meat", () => {
    const s = fire(7, { category: "misc", misc: "midasTouch" }, {
      resources: { ...emptyPool(), meat: 20 },
    });
    // 2 meat upkeep → 18; +floor(18/5)=3 gold; −floor(18*0.25)=4 meat → 14.
    expect(s.resources.gold).toBe(3);
    expect(s.resources.meat).toBe(14);
  });

  it("Barn Fire burns half the wood/wheat and one barn (when 2+)", () => {
    let s = onYearBoundary(8, { category: "misc", misc: "barnFire" });
    s = withBuilding(withBuilding(s, "barn", 9001), "barn", 9002);
    s = { ...s, resources: { ...emptyPool(), meat: 2, wood: 10, wheat: 10 } };
    s = update(s, [], 1);
    expect(s.resources.wood).toBe(5);
    expect(s.resources.wheat).toBe(5);
    expect(countBuildings(s, "barn")).toBe(1); // one of the two collapsed
  });

  it("Neighbors auto-build a house and a barn", () => {
    const s = fire(9, { category: "misc", misc: "neighbors" }, {
      resources: { ...emptyPool(), meat: 2 },
    });
    expect(countBuildings(s, "house")).toBe(3); // 2 starting + 1 gift
    expect(countBuildings(s, "barn")).toBe(1);
  });

  it("Migrant Laborers fill the houses to capacity", () => {
    let s = onYearBoundary(10, { category: "misc", misc: "migrantLaborers" });
    s = withBuilding(s, "house", 9001); // capacity 4 → 6
    s = { ...s, resources: { ...emptyPool(), meat: 50 } };
    s = update(s, [], 1);
    expect(countUnits(s, "worker")).toBe(6); // filled to the 6-slot cap
  });

  it("Plague (HP roll) docks 25% of max HP from every unit", () => {
    // Find a seed where the HP branch fires (no unit lost, HP reduced).
    let found = false;
    for (let seed = 1; seed <= 80 && !found; seed++) {
      const s = fire(seed, { category: "misc", misc: "plague" }, {
        resources: { ...emptyPool(), meat: 50 },
      });
      if (countUnits(s, "worker") === 4 && Object.values(s.units).every((u) => u.hp < 10)) {
        // Worker max HP 10, −25% = ceil(2.5)=3 → 7.
        expect(Object.values(s.units).every((u) => u.hp === 7)).toBe(true);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe("misc trade dialogs (§16.3, item 32)", () => {
  it("Forest Alchemist opens a trade dialog and converts wood on demand", () => {
    let s = onYearBoundary(2, { category: "misc", misc: "forestAlchemist" });
    s = { ...s, resources: { ...emptyPool(), meat: 2, wood: 20 } };
    s = update(s, [], 1);
    expect(s.activeEvent?.category).toBe("misc");
    if (s.activeEvent?.category === "misc") {
      expect(s.activeEvent.trade?.kind).toBe("forestAlchemist");
    }
    expect(s.resources.wood).toBe(20); // no up-front effect

    s = update(s, [{ type: "miscTrade", offerId: "iron" }], 1); // 2 wood → 1 iron
    expect(s.resources.wood).toBe(18);
    expect(s.resources.iron).toBe(1);

    s = update(s, [{ type: "miscTrade", offerId: "sword" }], 1); // 6 wood → 1 sword
    expect(s.resources.wood).toBe(12);
    expect(s.equipment.sword).toBe(1);

    s = update(s, [{ type: "acknowledgeEvent" }], 1); // closing ends trading
    expect(s.phase).toBe("playing");
    expect(s.activeEvent).toBeNull();
  });

  it("Trader buys and sells at town value against the pool", () => {
    let s = onYearBoundary(2, { category: "misc", misc: "trader" });
    s = { ...s, resources: { ...emptyPool(), meat: 2, wood: 10 } };
    s = update(s, [], 1);
    s = update(s, [{ type: "miscTrade", offerId: "sell-wood" }], 1); // 1 wood → 3 gold
    expect(s.resources.wood).toBe(9);
    expect(s.resources.gold).toBe(3);
    s = update(s, [{ type: "miscTrade", offerId: "buy-wheat" }], 1); // 2 gold → 1 wheat
    expect(s.resources.gold).toBe(1);
    expect(s.resources.wheat).toBe(1);
  });

  it("Mercenaries respects per-offer caps and barracks housing", () => {
    let s = onYearBoundary(2, { category: "misc", misc: "mercenaries" });
    s = withBuilding(s, "barracks", 9001); // 4 military slots
    s = { ...s, resources: { ...emptyPool(), meat: 2, gold: 50 } };
    s = update(s, [], 1);

    // First captain: 3 gold, spawns one captain (max 1).
    s = update(s, [{ type: "miscTrade", offerId: "captain" }], 1);
    expect(s.resources.gold).toBe(47);
    expect(countUnits(s, "captain")).toBe(1);
    // Second captain is capped out: nothing changes.
    s = update(s, [{ type: "miscTrade", offerId: "captain" }], 1);
    expect(s.resources.gold).toBe(47);
    expect(countUnits(s, "captain")).toBe(1);
    // A soldier still fits (1 gold, max 3).
    s = update(s, [{ type: "miscTrade", offerId: "soldier" }], 1);
    expect(s.resources.gold).toBe(46);
    expect(countUnits(s, "soldier")).toBe(1);

    s = update(s, [{ type: "acknowledgeEvent" }], 1);
    expect(s.phase).toBe("playing");
  });
});

describe("loss conditions (req §21.1)", () => {
  it("ends the game when the Main Hall is destroyed", () => {
    let s = createInitialState(31);
    s = { ...s, tickCount: 100 }; // away from any boundary
    const buildings = { ...s.buildings };
    for (const id of Object.keys(buildings)) {
      if (buildings[Number(id)].kind === "mainHall") delete buildings[Number(id)];
    }
    s = { ...s, buildings };
    s = update(s, [], 1);
    expect(s.phase).toBe("gameOver");
  });

  it("ends the game when all workers are dead", () => {
    let s = createInitialState(32);
    s = { ...s, tickCount: 100, units: {} };
    s = update(s, [], 1);
    expect(s.phase).toBe("gameOver");
  });
});
