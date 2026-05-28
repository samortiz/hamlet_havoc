// HUD layer (req §2.2, §19). Reads GameState and reflects it into the HTML
// overlay. Read-only with respect to simulation state.

import { deriveSeason, type GameState } from "../game/state.js";

export interface Hud {
  update: (state: GameState, paused: boolean) => void;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD element #${id} not found`);
  return node;
}

export function createHud(): Hud {
  const seasonEl = el("hud-season");
  const timerEl = el("hud-timer");
  const pausedEl = el("hud-paused");
  const tickEl = el("hud-tick");

  function update(state: GameState, paused: boolean) {
    const { season, year, secondsRemaining } = deriveSeason(state.tickCount);
    seasonEl.textContent = `${season}, Year ${year}`;
    timerEl.textContent = `${secondsRemaining}s`;
    tickEl.textContent = `tick ${state.tickCount}`;
    pausedEl.hidden = !paused;
  }

  return { update };
}
