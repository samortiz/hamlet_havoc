// Single source of truth for tunable constants (req §2.6 data-driven config, §26).
// Durations are authored in real seconds, then converted to ticks once (req §2.7).

export const TICKS_PER_SECOND = 30;

export const ticks = (seconds: number): number =>
  Math.round(seconds * TICKS_PER_SECOND);

// --- Map (req §4) ---
export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 60;
export const TILE_SIZE = 32;

// --- Time & seasons (req §15) ---
export const SEASONS = ["Spring", "Summer", "Fall", "Winter"] as const;
export type Season = (typeof SEASONS)[number];
export const SECONDS_PER_SEASON = 60;
export const TICKS_PER_SEASON = ticks(SECONDS_PER_SEASON);
export const TICKS_PER_YEAR = TICKS_PER_SEASON * SEASONS.length;

// --- Units (req §6, §26) ---
export const BASE_MOVE_TILES_PER_SEC = 2;
export const WORKER_CARRY_CAP = 5; // resource slots (req §6.1)

// --- Gathering rates (req §10, §12, §13, §14, §26) ---
export const WOOD_TICKS_PER_UNIT = ticks(5); // 1 wood / 5 sec
export const FISH_TICKS_PER_UNIT = ticks(5); // base; seasonal variance lands in M4 (§14)
export const ORE_TICKS_PER_UNIT = ticks(5); // 1 yield / 5 sec
export const FOREST_WOOD_MAX = 5; // wood per forest tile before it becomes a stump (§12)

// Mine type probabilities (§13.1) and gold-mine diamond chance (§13.2).
export const MINE_TYPE_WEIGHTS = { stone: 0.5, iron: 0.4, gold: 0.1 } as const;
export const DIAMOND_CHANCE = 0.1; // per gold-mine yield

// --- Farming (req §10, §11, §26) ---
export const WHEAT_YIELD_PER_TILE = 4;
export const PLANT_WHEAT_COST = 1; // seed per planted tile
export const PLOUGH_TICKS = ticks(20);
export const PLANT_TICKS = ticks(20);
export const HARVEST_TICKS = ticks(20);
// M2 placeholder: planted crops mature after this many ticks. M4 replaces this
// with season-gated growth (plant=spring, mature in summer, harvest=fall).
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
  // fields (tile features, req §7/§11)
  fieldPloughed: "#6b5436",
  fieldPlanted: "#7c8a3f",
  fieldGrown: "#c9a96e",
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
  selectionRing: "#d4af37",
  dragBox: "rgba(212,175,55,0.22)",
  dragBoxBorder: "#d4af37",
} as const;
