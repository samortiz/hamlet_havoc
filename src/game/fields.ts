// Tile features — farm fields and hay fields (req §7, §11). Fields are NOT
// buildings: they are flimsy tile features layered over a grass/stump tile and
// they don't block walking. Both wheat fields and hay fields live here.
//
// Wheat-field stages (req §11): ploughed -> planted -> grown -> (harvested
// back to ploughed for replanting). Plough is a worker action; the field
// appears the moment ploughing completes (M2).
//
// Hay-field stages (req §7, §12+): underConstruction -> mature. Construction
// takes HAY_FIELD_BUILD_TICKS and costs HAY_FIELD_COST; once mature it yields
// hay continuously (production rate lands in M4 alongside the season cycle).

import { FIELD_HP } from "../config/index.js";

export type FieldKind = "wheat" | "hay";
export type FieldStage =
  | "ploughed"
  | "planted"
  | "grown"
  | "hayBuilding"
  | "hayMature";

export interface Field {
  id: number;
  kind: FieldKind;
  x: number; // tile
  y: number;
  stage: FieldStage;
  hp: number;
  plantedTick: number; // wheat: when planting happened; drives growth timing
  buildProgress: number; // hay: ticks accumulated toward construction
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
    stage: kind === "wheat" ? "ploughed" : "hayBuilding",
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
