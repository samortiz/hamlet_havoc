// Farm fields (req §7, §11). A field is a tile feature laid over a grass tile,
// not a structure: ploughed -> planted -> grown, then harvested back to ploughed
// so it can be replanted. Plain id-based data; looked up by tile position.

import { FIELD_HP } from "../config/index.js";

export type FieldStage = "ploughed" | "planted" | "grown";

export interface Field {
  id: number;
  x: number; // tile
  y: number;
  stage: FieldStage;
  hp: number;
  plantedTick: number; // when planting happened; drives M2 growth timing
}

export function makeField(id: number, x: number, y: number): Field {
  return { id, x, y, stage: "ploughed", hp: FIELD_HP, plantedTick: 0 };
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
