// Tile features — farm fields and stables (req §7, §11). Fields are NOT
// buildings: they are flimsy tile features layered over a grass/stump tile and
// they don't block walking. Both wheat fields and stables live here.
//
// Wheat-field stages (req §11): ploughed -> planted -> grown -> (harvested
// back to ploughed for replanting). Plough is a worker action; the field
// appears the moment ploughing completes.
//
// Stables stages (req §7, §12+): underConstruction -> mature. Construction
// takes STABLES_BUILD_TICKS and costs STABLES_COST; once mature it provides
// horse stabling capacity alongside the season cycle.

import { FIELD_HP } from "../config/index.js";

export type FieldKind = "wheat" | "stables";
export type FieldStage =
  | "ploughed"
  | "planted"
  | "grown"
  | "stablesBuilding"
  | "stablesMature";

export interface Field {
  id: number;
  kind: FieldKind;
  x: number; // tile
  y: number;
  stage: FieldStage;
  hp: number;
  plantedTick: number; // wheat: when planting happened; drives growth timing
  buildProgress: number; // stables: ticks accumulated toward construction
}

export function makeField(
  id: number,
  x: number,
  y: number,
  kind: FieldKind = "wheat",
): Field {
  return {
    id,
    kind,
    x,
    y,
    stage: kind === "wheat" ? "ploughed" : "stablesBuilding",
    hp: FIELD_HP,
    plantedTick: 0,
    buildProgress: 0,
  };
}

export function fieldAt(
  fields: Record<number, Field>,
  x: number,
  y: number,
): Field | undefined {
  for (const f of Object.values(fields)) {
    if (f.x === x && f.y === y) return f;
  }
  return undefined;
}
