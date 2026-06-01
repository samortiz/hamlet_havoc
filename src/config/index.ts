// Single source of truth for tunable constants (req §2.6 data-driven config, §26).
// Durations are authored in real seconds, then converted to ticks once (req §2.7).

import type { ResourceType } from "../game/resources.js";

export const TICKS_PER_SECOND = 30;

export const ticks = (seconds: number): number =>
  Math.round(seconds * TICKS_PER_SECOND);

// --- Map (req §4) ---
// Pointy-top hex grid, odd-r offset coordinates. The row-major tiles[] array
// stores them like a square grid — only the adjacency, distance, and pixel
// math differ (see src/game/hex.ts).
export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 40;
// Circumradius of a single hex in CSS pixels. Hex width = √3 · HEX_SIZE,
// height = 2 · HEX_SIZE. Sized so Kenney hexagon sprites (120×140 native ≈
// circumradius 70) downscale crisply onto a ~70×80 footprint.
export const HEX_SIZE = 40;

// --- Time & seasons (req §15) ---
export const SEASONS = ["Spring", "Summer", "Fall", "Winter"] as const;
export type Season = (typeof SEASONS)[number];
export const SECONDS_PER_SEASON = 60;
export const TICKS_PER_SEASON = ticks(SECONDS_PER_SEASON);
export const TICKS_PER_YEAR = TICKS_PER_SEASON * SEASONS.length;

// --- Units (req §6, §26) ---
export const BASE_MOVE_TILES_PER_SEC = 2;
export const WORKER_CARRY_CAP = 5; // resource slots (req §6.1)

// A dice expression `count`D`sides`+`bonus` (req §6.1, §6.2): e.g. 2D8+5 is
// `{ count: 2, sides: 8, bonus: 5 }`. A flat value N is `{ count: 0, sides: 0,
// bonus: N }`. Rolled by `rollDice` in combat.ts. Attack and defense are both
// dice now — the attacker rolls the defender's defense at hit time.
export interface Dice {
  count: number;
  sides: number;
  bonus: number;
}

// Combat stats per unit kind (req §6.1). Attack and defense are dice rolled per
// swing; damage is attack roll minus defense roll (min 0). Keyed by the literal
// kind strings (mirrors UNIT_MAX_HP) so config imports no unit type.
export const UNIT_ATTACK: Record<"worker" | "soldier" | "captain", Dice> = {
  worker: { count: 1, sides: 6, bonus: 0 }, // 1D6
  soldier: { count: 2, sides: 6, bonus: 0 }, // 2D6
  captain: { count: 2, sides: 8, bonus: 5 }, // 2D8+5
};
export const UNIT_DEFENSE: Record<"worker" | "soldier" | "captain", Dice> = {
  worker: { count: 0, sides: 0, bonus: 0 }, // 0
  soldier: { count: 0, sides: 0, bonus: 2 }, // 2
  captain: { count: 1, sides: 4, bonus: 1 }, // 1D4+1
};

// Combat resolution (req §17.1): adjacent opposing units attack once per second.
export const ATTACK_INTERVAL_TICKS = TICKS_PER_SECOND;

// Healing (req §6.2). A wounded unit regenerates HEAL_PERCENT_PER_INTERVAL of its
// max HP every HEAL_INTERVAL_TICKS *while idle*; on a season change every wounded
// unit gets an immediate SEASON_HEAL_PERCENT of max HP, idle or not.
export const HEAL_PERCENT_PER_INTERVAL = 0.05; // +5% max HP per interval
export const HEAL_INTERVAL_TICKS = ticks(5); // every 5 seconds
export const SEASON_HEAL_PERCENT = 0.25; // +25% max HP at each season change

// Equipment effects (req §6.4, §7.2). A unit may hold at most one sword and one
// shield; each equipped item also occupies one carry slot (handled in units.ts).
// The equipped die is added to the attack/defense roll.
export const SWORD_ATTACK_DICE: Dice = { count: 1, sides: 6, bonus: 0 }; // +1D6 Attack
export const SHIELD_DEFENSE_DICE: Dice = { count: 1, sides: 4, bonus: 0 }; // +1D4 Defense

// The six enemy kinds (req §6.1). Mirrors the `EnemyKind` union in combat.ts as
// literal strings so config imports no game types.
export type EnemyKindName =
  | "giantSpider"
  | "goblin"
  | "goblinChief"
  | "seaSerpent"
  | "kraken"
  | "dragon";

// Enemy stats (req §6.1 Enemies table). hp + attack dice + defense dice.
// `giantSpider`/`goblin`/`goblinChief`/`dragon` are land enemies that march on
// the hamlet; `seaSerpent`/`kraken` are water predators (they never leave water).
export const ENEMY_STATS: Record<
  EnemyKindName,
  { hp: number; attack: Dice; defense: Dice }
> = {
  giantSpider: { hp: 5, attack: { count: 1, sides: 4, bonus: 0 }, defense: { count: 0, sides: 0, bonus: 0 } }, // 1D4 / 0
  goblin: { hp: 10, attack: { count: 1, sides: 4, bonus: 0 }, defense: { count: 0, sides: 0, bonus: 0 } }, // 1D4 / 0
  goblinChief: { hp: 18, attack: { count: 1, sides: 12, bonus: 0 }, defense: { count: 0, sides: 0, bonus: 2 } }, // 1D12 / 2
  seaSerpent: { hp: 8, attack: { count: 1, sides: 4, bonus: 0 }, defense: { count: 0, sides: 0, bonus: 0 } }, // 1D4 / 0
  kraken: { hp: 20, attack: { count: 1, sides: 12, bonus: 0 }, defense: { count: 0, sides: 0, bonus: 2 } }, // 1D12 / 2
  dragon: { hp: 50, attack: { count: 2, sides: 12, bonus: 3 }, defense: { count: 1, sides: 6, bonus: 0 } }, // 2D12+3 / 1D6
};

// Enemy loot (req §6.2). On death an enemy drops one outcome, picked by weight
// from its list; each outcome is a bundle of resource stacks (so e.g. a dragon
// can drop "2 gold + 1 diamond" together). The killing unit picks the loot up if
// it has carry room, otherwise it falls to the ground for any unit to collect.
export interface LootOutcome {
  weight: number;
  drops: { resource: ResourceType; qty: number }[];
}
export const LOOT: Record<EnemyKindName, LootOutcome[]> = {
  giantSpider: [
    { weight: 60, drops: [{ resource: "meat", qty: 1 }] },
    { weight: 40, drops: [{ resource: "meat", qty: 2 }] },
  ],
  goblin: [
    { weight: 60, drops: [{ resource: "iron", qty: 1 }] },
    { weight: 30, drops: [{ resource: "iron", qty: 2 }] },
    { weight: 10, drops: [{ resource: "gold", qty: 1 }] },
  ],
  goblinChief: [
    { weight: 40, drops: [{ resource: "gold", qty: 1 }] },
    { weight: 40, drops: [{ resource: "gold", qty: 2 }] },
    { weight: 20, drops: [{ resource: "gold", qty: 3 }] },
  ],
  seaSerpent: [
    { weight: 80, drops: [{ resource: "meat", qty: 1 }] },
    { weight: 20, drops: [{ resource: "meat", qty: 2 }] },
  ],
  kraken: [
    { weight: 60, drops: [{ resource: "gold", qty: 1 }] },
    { weight: 30, drops: [{ resource: "gold", qty: 2 }] },
    { weight: 10, drops: [{ resource: "diamond", qty: 1 }] },
  ],
  dragon: [
    { weight: 60, drops: [{ resource: "gold", qty: 4 }] },
    { weight: 30, drops: [{ resource: "gold", qty: 2 }, { resource: "diamond", qty: 1 }] },
    { weight: 10, drops: [{ resource: "diamond", qty: 2 }] },
  ],
};

// --- Enemy AI & spawning (req §13.2, §17.3) ---
// Land enemies (goblins) march toward the hamlet a little slower than a worker.
// Water enemies (sea serpent / kraken) never move; they sit on their water tile.
export const ENEMY_MOVE_TILES_PER_SEC = 1.5;
// Per mining yield at an iron/gold mine, the chance a goblin spawns near it and
// focuses the miner (req §13.2: "15% chance per mining interval").
export const MINE_GOBLIN_SPAWN_CHANCE = 0.15;
// Per fishing yield, two independent rolls decide which water predators surface
// to attack the fisher (req §14): a 15% chance of a sea serpent and a separate
// 7% chance of a kraken. When both fire on the same yield the kraken (the nastier
// of the two) is the one that spawns.
export const SERPENT_SPAWN_CHANCE = 0.15;
export const KRAKEN_SPAWN_CHANCE = 0.07;

// --- Horses (req §9, §26) ---
// Bought in town for resources worth HORSE_COST_VALUE (e.g. 4 meat or 10 wheat).
// A horse adds 10 buffer HP that take damage first (the horse dies once those 10
// HP are gone), doubles travel speed, and adds 5 carry slots. Horses have no
// per-season upkeep (§9); hay-field capacity gates ownership instead.
export const HORSE_COST_VALUE = 20;
export const HORSE_BONUS_HP = 10;
export const HORSE_CARRY_BONUS = 5;
export const HORSE_SPEED_MULT = 2;
// Each mature hay field stables this many horses (req §9); a horse can't be
// bought when every stable slot is taken.
export const HAY_FIELD_HORSE_CAPACITY = 2;

// --- Town marketplace (req §18) ---
// A fixed map location far from the Main Hall where units physically trade
// resources at their listed values and buy horses. The exact tile is chosen at
// map-gen time (nearest walkable grass to this fractional target corner).
export const TOWN_TARGET_FRACTION = { x: 0.12, y: 0.12 } as const;

// Upkeep charged at the end of each season (req §6.3). The *amount* lives here;
// which resource each kind consumes (worker: meat-or-wheat, soldier: meat,
// captain: gold) and the demotion fallback are sim logic in actions.ts.
export const UPKEEP = {
  worker: 1, // 1 food (meat or wheat) — unpaid → dies
  soldier: 1, // 1 meat — unpaid → demoted to worker
  captain: 1, // 1 gold — unpaid → demoted to soldier
} as const;

// --- Gathering rates (req §10, §12, §13, §14, §26) ---
export const WOOD_TICKS_PER_UNIT = ticks(5); // 1 wood / 5 sec
export const FISH_TICKS_PER_UNIT = ticks(5); // base rate (spring/fall); see season table below
export const ORE_TICKS_PER_UNIT = ticks(5); // 1 yield / 5 sec
// Wood per forest tile before it becomes a stump (§12): 1D6+2 → a uniform 3–8,
// rolled at map-gen and re-rolled fresh on each spring regrowth.
export const FOREST_WOOD_MIN = 3;
export const FOREST_WOOD_MAX = 8;
// When a worker chops a forest tile out, it hops to the nearest forest tile that
// still has wood within this hex radius of the depleted tile and keeps chopping.
// It only stops if no such tile is in range (req: workers roam to nearby trees).
export const WOOD_ROAM_RADIUS = 2;

// Seasonal fishing variance (req §14, §15.3): faster in summer, reduced in
// winter, base rate in spring/fall. Authored as seconds-per-meat → ticks.
export const FISH_TICKS_BY_SEASON: Record<Season, number> = {
  Spring: ticks(5),
  Summer: ticks(3), // summer fishing bonus (§15.3)
  Fall: ticks(5),
  Winter: ticks(10), // reduced fishing (§15.3)
};

// Every mountain tile has a type (stone/iron/gold), rolled at map-gen with
// these weights. Stone is the common rock, gold the rare seam.
export const MOUNTAIN_TYPE_WEIGHTS = { stone: 0.6, iron: 0.3, gold: 0.1 } as const;

// Mine-type probabilities (§13.1) now depend on the host mountain's type:
// a stone mountain mostly yields a stone mine, a gold mountain often a gold one.
// Each row sums to 1.0.
export const MINE_TYPE_WEIGHTS_BY_MOUNTAIN = {
  stone: { stone: 0.8, iron: 0.15, gold: 0.05 },
  iron: { stone: 0.4, iron: 0.5, gold: 0.1 },
  gold: { stone: 0.4, iron: 0.2, gold: 0.4 },
} as const;

export const DIAMOND_CHANCE = 0.1; // per gold-mine yield

// --- Farming (req §10, §11, §26) ---
// A harvested wheat field yields a random amount in [MIN, MAX]: farming is
// meant to be a low-effort staple, so one field feeds the hamlet for a while.
export const WHEAT_HARVEST_MIN = 10;
export const WHEAT_HARVEST_MAX = 20;
export const PLANT_WHEAT_COST = 1; // seed per planted tile
export const PLOUGH_TICKS = ticks(10);
export const PLANT_TICKS = ticks(10); // planting is quick (10 s)
export const HARVEST_TICKS = ticks(10);
// Planted wheat matures one season after planting (req §11: plant in spring →
// grow through summer → harvestable in fall). Planting is spring-locked and
// harvest is fall-locked (see season.ts), so a one-season grow timer lands the
// crop in the harvest window; unharvested crops are lost at fall's end (§11.5).
export const CROP_GROW_TICKS = TICKS_PER_SEASON;

// --- Buildings (req §7, §7.4, §26) ---
export const BARRACKS_HOUSING_CAPACITY = 4;
export const HOUSE_HOUSING_CAPACITY = 2;
// Storage each building adds to the single pooled limit (§7).
export const BUILDING_STORAGE = {
  mainHall: 20,
  house: 10,
  barn: 50,
  smithy: 0,
  barracks: 0,
  mine: 0,
} as const;
// Build HP values (§7).
export const BUILDING_HP = {
  mainHall: 100,
  house: 50,
  barn: 60,
  smithy: 80,
  barracks: 80,
  mine: 50,
} as const;
export const FIELD_HP = 5; // ploughed/hay fields are flimsy tile features (§7)

// Construction times in ticks (§7 table). Starting buildings are spawned
// already complete (progress = BUILD_TICKS[kind]) in createInitialState.
export const BUILD_TICKS = {
  mainHall: ticks(60),
  house: ticks(15),
  barn: ticks(15),
  smithy: ticks(30),
  barracks: ticks(30),
  mine: ticks(30),
} as const;

// Hay-field is a tile feature (like a ploughed field), not a building (§7).
// Construction time + cost shipped here so the build flow stays data-driven.
export const HAY_FIELD_BUILD_TICKS = ticks(10);

// Construction cost per kind (§7 table). A blank record means "no cost"
// (e.g., mainHall is pre-built and never placed by the player).
export type BuildCost = Partial<Record<
  "wheat" | "wood" | "stone" | "meat" | "iron" | "gold" | "diamond",
  number
>>;
export const BUILDING_COST: Record<keyof typeof BUILD_TICKS, BuildCost> = {
  mainHall: {}, // not buildable
  house: { wood: 3, wheat: 2 },
  barn: { wood: 5 },
  smithy: { stone: 3, wood: 3 },
  barracks: { stone: 3, wood: 4, iron: 2 },
  mine: { wood: 4 },
};
export const HAY_FIELD_COST: BuildCost = { wood: 3 };

// --- Smithy crafting (§7.2) ---
// Per-item craft times: Sword 20s, Shield 30s.
export const CRAFT_TICKS: Record<"sword" | "shield", number> = {
  sword: ticks(20),
  shield: ticks(30),
};
export const CRAFT_COST: Record<"sword" | "shield", BuildCost> = {
  sword: { iron: 3 },
  shield: { iron: 2, wood: 2 },
};

// --- Barracks training (§7.3) ---
// "Worker → Soldier: 1 season. Soldier → Captain: 1 season."
export const TRAIN_TICKS = TICKS_PER_SEASON;

// --- Main Hall worker production ---
// The Main Hall can raise a fresh worker for free; it just takes time. Gated by
// worker housing like any other unit creation (§7.4).
export const WORKER_SPAWN_TICKS = ticks(20);

// HP per unit kind (§6.1). Soldier/Captain are here because training
// promotes a worker into one.
export const UNIT_MAX_HP = {
  worker: 10,
  soldier: 20,
  captain: 40,
} as const;

// --- End-of-year events (req §16, §26) ---
// One event fires per year at the winter→spring boundary. The category follows a
// fixed deterministic cadence (§16.0): year 1 is a good Misc; years 2-3 are one
// Attack + one Tax (random order); every later rolling 3-year block (4-6, 7-9,
// …) is one each of {Misc, Tax, Attack} (random order). The per-block order is a
// seeded shuffle in events.ts, so there is no weighting constant to tune.

// Attack scaling (§16.1). Each of the four flavours keys off a different hamlet
// stat (rolled at trigger) plus the year, so later waves are larger and the
// player cannot optimise against a single stat. A wave is never empty: the
// goblin floor grows by 1 every ATTACK_MIN_GOBLIN_YEARS years.
export const ATTACK_MIN_GOBLIN_YEARS = 3; // +1 minimum goblin per 3 years

// Raiding party — keys off worker count.
export const RAID_WORKERS_PER_GOBLIN = 2; // floor(workers / 2) goblins
export const RAID_CHIEF_SWORD_THRESHOLD = 2; // +1 goblinChief at 2+ swords held

// Warband — keys off building count (houses/barns/smithy/barracks).
export const WARBAND_BUILDINGS_PER_GOBLIN = 2; // floor(buildings / 2) goblins
export const WARBAND_SPIDERS_PER_MILITARY = 2; // +2 giantSpiders per smithy/barracks
export const WARBAND_CHIEF_MINE_THRESHOLD = 4; // +1 goblinChief if > 4 mines

// Plunder — keys off total stored resource value.
export const PLUNDER_VALUE_PER_GOBLIN = 60; // floor(value / 60) goblins
export const PLUNDER_GOLD_PER_CHIEF = 15; // +1 goblinChief per 10 gold stored

// Goblin/Dragon Attack — keys off gold/diamonds.
export const DRAGON_DIAMOND_THRESHOLD = 2; // 2+ diamonds → a single dragon
export const GOBLIN_ATTACK_GOLD_THRESHOLD = 10; // else 10+ gold → goblin chief + goblins
export const GOBLIN_ATTACK_GOLD_PER_GOBLIN = 5; // +1 goblin per 5 gold stored

// Tax (§16.2): the gold demand is set by a seeded tax flavour, each keyed off a
// different hamlet stat plus the year (so later taxes bite harder). All the
// coefficients are tunable here; startTax in actions.ts applies the matching
// per-flavour formula. The `*Divisor` fields are floor-divided (Wealth/Resource).
export interface TaxFlavourCoeffs {
  perWorker?: number;
  perSword?: number;
  perShield?: number;
  perSmithy?: number;
  perBarn?: number;
  perBarracks?: number;
  perHouse?: number;
  perHorse?: number;
  perDiamond?: number;
  goldDivisor?: number;
  wheatDivisor?: number;
  woodDivisor?: number;
  meatDivisor?: number;
  stoneDivisor?: number;
  ironDivisor?: number;
  perYear: number; // always applied (× the completed-year count)
}

export const TAX_FLAVOUR_COEFFS: Record<string, TaxFlavourCoeffs> = {
  worker: { perWorker: 2, perYear: 2 },
  weapon: { perSword: 4, perShield: 4, perYear: 2 },
  building: { perSmithy: 5, perBarn: 2, perBarracks: 5, perYear: 2 },
  housing: { perHouse: 4, perYear: 3 },
  animal: { perHorse: 4, perYear: 3 },
  wealth: { goldDivisor: 5, perDiamond: 1, perYear: 3 },
  resource: {
    wheatDivisor: 20,
    woodDivisor: 20,
    meatDivisor: 10,
    stoneDivisor: 20,
    ironDivisor: 10,
    perYear: 2,
  },
};

// Tax payment pricing (§16.2.1). The demand is denominated in *gold* (1 gold = 1
// unit of demand) and is capped at TAX_MAX_GOLD_PER_YEAR × year so the early
// years bite gently. The player chooses what to surrender; each good covers the
// demand at a per-resource rate: gold at face value, diamonds at a 100% bonus
// (TAX_DIAMOND_MULT), every other resource at TAX_RESOURCE_FRACTION of its trade
// value — all normalised against gold's value so the rates land on the §16.2.1
// table (1 gold→1, 1 diamond→10, 10 wheat→1, 20 wood→3, 5 meat→1). A surrendered
// building pays TAX_BUILDING_FRACTION of its build-cost value at the same
// non-gold rate. Contributions are summed as decimals; no change is ever given.
export const TAX_MAX_GOLD_PER_YEAR = 5;
export const TAX_RESOURCE_FRACTION = 0.5;
export const TAX_DIAMOND_MULT = 2;
export const TAX_BUILDING_FRACTION = 0.5;

// Misc magnitudes (§16.3). Modest, mostly flat defaults to be tuned.
export const FESTIVAL_GATHER_MULT = 1.25; // +25% gather rate for the year
export const FESTIVAL_WORK_MULT = 0.75; // −25% build/craft/train time for the year
export const HARSH_WINTER_UPKEEP_MULT = 2; // doubles the next season-end upkeep
export const STORAGE_THIEF_FRACTION = 0.5; // Storage Thief steals 50% of one resource
export const PLAGUE_HP_FRACTION = 0.25; // Plague (HP roll) — −25% max HP across all units
export const BOUNTIFUL_HARVEST_FRACTION = 0.5; // +50% of the single most-stored resource
export const CROP_BLIGHT_FRACTION = 0.5; // Crop Blight destroys 50% of stored wheat
export const BLIGHT_FRACTION = 0.25; // Blight: −25% wheat + −25% meat
export const WOOD_BOON_FRACTION = 0.5; // Wood Boon: +50% wood
export const BARN_FIRE_FRACTION = 0.5; // Barn Fire: −50% wood + −50% wheat (and a barn)
export const TERMITES_MEAT_PER_WOOD = 5; // Termites: +1 meat per 5 wood…
export const TERMITES_WOOD_LOSS_FRACTION = 0.75; // …then lose 75% of stored wood
export const MIDAS_GOLD_PER_MEAT = 5; // Midas Touch: +1 gold per 5 meat…
export const MIDAS_MEAT_LOSS_FRACTION = 0.25; // …then lose 25% of stored meat
export const LOST_CARAVAN_MIN = 2; // Lost Caravan windfall: 2–5 of two resources
export const LOST_CARAVAN_MAX = 5;

// --- Persistence (req §2.5) ---
export const SAVE_KEY = "hamlet-havoc-save";
export const AUTOSAVE_TICKS = ticks(10); // autosave every 10 sec of sim time

// --- Starting resources (req §5) ---
export const STARTING_WHEAT = 12;

// --- Camera & input (req §4.4, §20) ---
export const CAMERA_PAN_PX_PER_SEC = 600;
export const EDGE_SCROLL_MARGIN_PX = 24;
export const DRAG_SELECT_THRESHOLD_PX = 5;

// --- Map generation targets (req §4.3) ---
// Minimums per spec are forest ≥10%, water ≥5%, mountain ≥5%; we aim above.
export const TERRAIN_TARGET = { forest: 0.18, water: 0.08, mountain: 0.08 } as const;
export const HAMLET_CLEARING_RADIUS = 5;

// --- Visual palette (req §3.1) ---
export const COLORS = {
  grassDark: "#4a5d3a",
  grassLight: "#6b7d4f",
  brownDark: "#5c4a35",
  brownLight: "#8b7355",
  goldDim: "#c9a96e",
  gold: "#d4af37",
  parchment: "#e8dcc4",
  // terrain fills (placeholder, req §3.2)
  terrainGrass: "#6b7d4f",
  terrainForest: "#37432a",
  terrainWater: "#3f6079",
  terrainMountain: "#857c6e",
  terrainStump: "#5c4a35",
  gridLine: "rgba(0,0,0,0.08)",
  // fields (tile features, req §7/§11). Wheat greens up as it grows: a
  // freshly-planted field is a pale sprout-green, ripe-for-harvest is the
  // deepest green; the renderer lerps between these two as the crop matures.
  fieldPloughed: "#6b5436",
  fieldPlanted: "#9ccc65",
  fieldGrown: "#2e7d32",
  hayBuilding: "#7a6a52",
  hayMature: "#c4b070",
  // buildings (placeholder fills, req §3.2)
  buildingMainHall: "#8b7355",
  buildingHouse: "#a98c63",
  buildingOther: "#7a6a52",
  buildingOutline: "#2a2018",
  buildingLabel: "#2a2018",
  // entities & UI
  worker: "#e8dcc4",
  unitOutline: "#2a2018",
  carryCue: "#d4af37",
  // resource indicator colours (used for carry-cue circle)
  resourceWheat: "#e8c84a",
  resourceWood: "#7a5230",
  resourceStone: "#9aa3ad",
  resourceMeat: "#c45a3a",
  resourceIron: "#5a7a8a",
  resourceGold: "#d4af37",
  resourceDiamond: "#7adde8",
  selectionRing: "#d4af37",
  dragBox: "rgba(212,175,55,0.22)",
  dragBoxBorder: "#d4af37",
} as const;
