// The simulation core (req §2.6). A stateless, deterministic step:
// update(state, commands, dtTicks) -> newState. Imports nothing from render/ or
// ui/ and touches no DOM, so it runs headless in tests and serializes cleanly.

import { BASE_MOVE_TILES_PER_SEC, TICKS_PER_SECOND } from "../config/index.js";
import type { Command } from "./commands.js";
import { findPath } from "./pathfinding.js";
import type { GameState } from "./state.js";
import type { Unit } from "./units.js";

const TILES_PER_TICK = BASE_MOVE_TILES_PER_SEC / TICKS_PER_SECOND;

// Move a unit along its path by its movement budget for dtTicks. The budget
// loop keeps speed constant regardless of how path nodes line up with ticks.
function advanceUnit(unit: Unit, dtTicks: number): Unit {
  if (unit.order.type !== "move") return unit;
  const path = unit.order.path;
  let node = unit.order.node;
  let x = unit.x;
  let y = unit.y;
  let budget = TILES_PER_TICK * dtTicks;

  while (budget > 0 && node < path.length) {
    const t = path[node];
    const dx = t.x - x;
    const dy = t.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) {
      node++;
      continue;
    }
    if (dist <= budget) {
      x = t.x;
      y = t.y;
      node++;
      budget -= dist;
    } else {
      x += (dx / dist) * budget;
      y += (dy / dist) * budget;
      budget = 0;
    }
  }

  if (node >= path.length) return { ...unit, x, y, order: { type: "idle" } };
  return { ...unit, x, y, order: { type: "move", path, node } };
}

export function update(
  state: GameState,
  commands: readonly Command[],
  dtTicks: number,
): GameState {
  const units: Record<number, Unit> = { ...state.units };

  for (const cmd of commands) {
    if (cmd.type === "moveUnits") {
      for (const id of cmd.unitIds) {
        const u = units[id];
        if (!u) continue;
        const start = { x: Math.round(u.x), y: Math.round(u.y) };
        const path = findPath(state.map, start, { x: cmd.tx, y: cmd.ty });
        units[id] =
          path && path.length > 0
            ? { ...u, order: { type: "move", path, node: 0 } }
            : { ...u, order: { type: "idle" } };
      }
    }
  }

  for (const key of Object.keys(units)) {
    const id = Number(key);
    units[id] = advanceUnit(units[id], dtTicks);
  }

  return { ...state, units, tickCount: state.tickCount + dtTicks };
}
