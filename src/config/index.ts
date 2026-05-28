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
export const BASE_MOVE_TILES_PER_SEC = 1;

// --- Farming (req §11, §26) ---
export const WHEAT_YIELD_PER_TILE = 4;

// --- Buildings (req §7.4, §26) ---
export const BARRACKS_HOUSING_CAPACITY = 4;
export const HOUSE_HOUSING_CAPACITY = 2;

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
  gridLine: "rgba(0,0,0,0.08)",
  // entities & UI
  worker: "#e8dcc4",
  unitOutline: "#2a2018",
  selectionRing: "#d4af37",
  dragBox: "rgba(212,175,55,0.22)",
  dragBoxBorder: "#d4af37",
} as const;
