// The simulation core (req §2.6). A stateless, deterministic step:
// update(state, commands, dtTicks) -> newState. Imports nothing from render/ or
// ui/ and touches no DOM, so it runs headless in tests and serializes cleanly.
//
// Each step copies the mutable parts of state into a SimCtx, lets the command
// handlers set unit orders and the action systems advance them (mutating the
// context), then assembles the next immutable GameState. The previous state is
// never mutated.

import {
  advanceFieldGrowth,
  advanceUnit,
  startField,
  startGather,
  startMove,
  type SimCtx,
} from "./actions.js";
import { storageCapacity } from "./buildings.js";
import type { Command } from "./commands.js";
import type { GameMap } from "./map.js";
import type { GameState } from "./state.js";
import type { Unit } from "./units.js";

export function update(
  state: GameState,
  commands: readonly Command[],
  dtTicks: number,
): GameState {
  const units: Record<number, Unit> = { ...state.units };

  // Copy the mutable containers; the action systems write through `ctx`.
  const map: GameMap = {
    width: state.map.width,
    height: state.map.height,
    tiles: state.map.tiles.slice(),
    forestWood: { ...state.map.forestWood },
    mineType: { ...state.map.mineType },
  };
  const ctx: SimCtx = {
    map,
    resources: { ...state.resources },
    capacity: storageCapacity(state.buildings),
    buildings: state.buildings, // unchanged in M2 (construction is M3)
    fields: { ...state.fields },
    rngState: state.rngState,
    tickCount: state.tickCount + dtTicks,
    nextId: state.nextEntityId,
  };

  // 1) Commands become unit orders (pathfinding happens here, on the new map).
  for (const cmd of commands) {
    for (const id of cmd.unitIds) {
      const u = units[id];
      if (!u) continue;
      if (cmd.type === "moveUnits") {
        units[id] = { ...u, order: startMove(map, u, cmd.tx, cmd.ty) };
      } else if (cmd.type === "gather") {
        units[id] = { ...u, order: startGather(map, u, cmd.tx, cmd.ty) };
      } else {
        units[id] = { ...u, order: startField(map, u, cmd.action, cmd.tx, cmd.ty) };
      }
    }
  }

  // 2) Advance every unit's order by dtTicks.
  for (const key of Object.keys(units)) {
    const id = Number(key);
    units[id] = advanceUnit(units[id], dtTicks, ctx);
  }

  // 3) Mature any planted crops that have grown long enough.
  advanceFieldGrowth(ctx);

  return {
    ...state,
    map,
    units,
    fields: ctx.fields,
    resources: ctx.resources,
    rngState: ctx.rngState,
    nextEntityId: ctx.nextId,
    tickCount: ctx.tickCount,
  };
}
