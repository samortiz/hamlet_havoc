// Sprite loader (req §3.2). Preloads the Kenney hexagon-pack PNGs we use for
// terrain and buildings, indexed by a stable key. The renderer treats sprites
// as best-effort: an unloaded sprite falls back to its color fill, so the game
// is fully playable before the images decode.
//
// Source: Kenney Hexagon Pack (CC0), https://kenney.nl/assets/hexagon-pack.

import type { BuildingKind } from "../game/buildings.js";
import type { TileType } from "../game/map.js";

const ASSET_BASE = "/assets/sprites/";

// Stable keys for every sprite the renderer can ask for. Terrain keys mirror
// TileType; building keys mirror BuildingKind. Water has no sprite (the pack
// doesn't ship one) so it's intentionally omitted — the renderer keeps using
// the procedural blue fill for water tiles.
const TERRAIN_SPRITE_FILE: Partial<Record<TileType, string>> = {
  grass: "terrain_grass.png",
  forest: "terrain_forest.png",
  mountain: "terrain_mountain.png",
  stump: "terrain_stump.png",
};

const BUILDING_SPRITE_FILE: Record<BuildingKind, string> = {
  mainHall: "building_mainHall.png",
  house: "building_house.png",
  barn: "building_barn.png",
  smithy: "building_smithy.png",
  barracks: "building_barracks.png",
  mine: "building_mine.png",
};

const cache = new Map<string, HTMLImageElement>();

function load(file: string): HTMLImageElement {
  const img = new Image();
  img.src = ASSET_BASE + file;
  return img;
}

// Kick off all image decodes at module import. Each image is just an
// HTMLImageElement; the renderer checks `complete && naturalWidth > 0` before
// drawing to skip ones still in flight.
for (const file of Object.values(TERRAIN_SPRITE_FILE)) {
  if (file) cache.set(file, load(file));
}
for (const file of Object.values(BUILDING_SPRITE_FILE)) {
  cache.set(file, load(file));
}

function ready(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

export function terrainSprite(t: TileType): HTMLImageElement | null {
  const file = TERRAIN_SPRITE_FILE[t];
  if (!file) return null;
  const img = cache.get(file);
  return ready(img) ? img : null;
}

export function buildingSprite(k: BuildingKind): HTMLImageElement | null {
  const img = cache.get(BUILDING_SPRITE_FILE[k]);
  return ready(img) ? img : null;
}
