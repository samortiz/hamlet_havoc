// Single source of truth for tunable constants (req §2.6 data-driven config, §26).
// Durations are authored in real seconds, then converted to ticks once (req §2.7).

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

// Combat stats per unit kind (req §6.1). Attack is a [min, max] damage range
// rolled per swing; defense subtracts from incoming damage (min 0). Keyed by
// the literal kind strings (mirrors UNIT_MAX_HP) so config imports no unit type.
export const UNIT_ATTACK = {
  worker: { min: 0, max: 2 },
  soldier: { min: 1, max: 3 },
  captain: { min: 1, max: 5 },
} as const;
export const UNIT_DEFENSE = {
  worker: 0,
  soldier: 0,
  captain: 1,
} as const;

// Combat resolution (req §17.1): adjacent opposing units attack once per second.
export const ATTACK_INTERVAL_TICKS = TICKS_PER_SECOND;

// Equipment effects (req §6.4, §7.2). A unit may hold at most one sword and one
// shield; each equipped item also occupies one carry slot (handled in units.ts).
export const SWORD_ATTACK_BONUS = 1; // +1 Attack
export const SHIELD_DEFENSE_BONUS = 1; // +1 Defense

// Enemy stats (req §6.1). hp + attack range + defense; loot/spawn cadence is M6.
export const ENEMY_STATS = {
  goblin: { hp: 3, attack: { min: 0, max: 3 }, defense: 0 },
  seaSerpent: { hp: 3, attack: { min: 0, max: 2 }, defense: 0 },
  kraken: { hp: 5, attack: { min: 1, max: 3 }, defense: 1 },
} as const;

// --- Horses (req §9, §26) ---
// Bought in town for resources worth HORSE_COST_VALUE (e.g. 4 meat or 10 wheat).
// A horse adds 3 buffer HP that take damage first (the horse dies once those 3
// HP are gone), doubles travel speed, adds 5 carry slots, and costs 2 hay-or-
// wheat per season in upkeep.
export const HORSE_COST_VALUE = 20;
export const HORSE_BONUS_HP = 3;
export const HORSE_CARRY_BONUS = 5;
export const HORSE_SPEED_MULT = 2;
export const HORSE_UPKEEP = 2; // 2 hay OR 2 wheat per season

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
export const FOREST_WOOD_MAX = 5; // wood per forest tile before it becomes a stump (§12)
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
// these weights (T2). Stone is the common rock, gold the rare seam.
export const MOUNTAIN_TYPE_WEIGHTS = { stone: 0.6, iron: 0.3, gold: 0.1 } as const;

// Mine-type probabilities (§13.1) now depend on the host mountain's type (T2):
// a stone mountain mostly yields a stone mine, a gold mountain often a gold one.
// Each row sums to 1.0.
export const MINE_TYPE_WEIGHTS_BY_MOUNTAIN = {
  stone: { stone: 0.8, iron: 0.15, gold: 0.05 },
  iron: { stone: 0.4, iron: 0.5, gold: 0.1 },
  gold: { stone: 0.4, iron: 0.2, gold: 0.4 },
} as const;

export const DIAMOND_CHANCE = 0.1; // per gold-mine yield

// --- Farming (req §10, §11, §26) ---
// A harvested wheat field yields a random amount in [MIN, MAX] (T8): farming is
// meant to be a low-effort staple, so one field feeds the hamlet for a while.
export const WHEAT_HARVEST_MIN = 10;
export const WHEAT_HARVEST_MAX = 20;
export const PLANT_WHEAT_COST = 1; // seed per planted tile
export const PLOUGH_TICKS = ticks(20);
export const PLANT_TICKS = ticks(10); // T8: planting is quick (10 s)
export const HARVEST_TICKS = ticks(20);
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
// Build HP values (§7); only the starting buildings matter in M2.
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
  house: ticks(20),
  barn: ticks(30),
  smithy: ticks(60),
  barracks: ticks(60),
  mine: ticks(30),
} as const;

// Hay-field is a tile feature (like a ploughed field), not a building (§7).
// Construction time + cost shipped here so the build flow stays data-driven.
export const HAY_FIELD_BUILD_TICKS = ticks(30);

// Construction cost per kind (§7 table). A blank record means "no cost"
// (e.g., mainHall is pre-built and never placed by the player).
export type BuildCost = Partial<Record<
  "hay" | "wheat" | "wood" | "stone" | "meat" | "iron" | "gold" | "diamond",
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
export const HAY_FIELD_COST: BuildCost = { wood: 2 };

// --- Smithy crafting (§7.2) ---
// "Each item takes 1 season to craft" — so craft duration tracks season length.
export const CRAFT_TICKS = TICKS_PER_SEASON;
export const CRAFT_COST: Record<"sword" | "shield", BuildCost> = {
  sword: { iron: 2 },
  shield: { iron: 2, wood: 2 },
};

// --- Barracks training (§7.3) ---
// "Worker → Soldier: 1 season. Soldier → Captain: 1 season."
export const TRAIN_TICKS = TICKS_PER_SEASON;

// --- Main Hall worker production (T5) ---
// The Main Hall can raise a fresh worker for free; it just takes time. Gated by
// worker housing like any other unit creation (§7.4).
export const WORKER_SPAWN_TICKS = ticks(20);

// HP per unit kind (§6.1). Soldier/Captain land here in M3 because training
// promotes a worker into one, even though combat is still M5.
export const UNIT_MAX_HP = {
  worker: 2,
  soldier: 4,
  captain: 6,
} as const;

// --- Persistence (req §2.5) ---
export const SAVE_KEY = "hamlet-havoc-save";
export const AUTOSAVE_TICKS = ticks(10); // autosave every 10 sec of sim time

// --- Starting resources (req §5) ---
export const STARTING_WHEAT = 4;

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
  // fields (tile features, req §7/§11). Wheat greens up as it grows (T8): a
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
  resourceHay: "#c9a86a",
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
