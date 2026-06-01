// Save format = JSON serialization of the central state (req §2.5). Because the
// state is plain, id-based data with no cycles (req §2.6), this is a plain
// stringify/parse. LocalStorage wiring (auto-save / manual save) builds on
// these pure helpers.

import { SAVE_VERSION, type GameState } from "./state.js";

export function serialize(state: GameState): string {
  // `damageEvents`/`healEvents` are transient render-feed data (combat damage and
  // heal toasts): they are regenerated every sim step and mean nothing once
  // reloaded, so they stay out of the save and don't affect the serialized shape.
  return JSON.stringify(state, (key, value) =>
    key === "damageEvents" || key === "healEvents" ? undefined : value,
  );
}

export function deserialize(json: string): GameState {
  const state = JSON.parse(json) as GameState;
  if (state.version !== SAVE_VERSION) {
    throw new Error(
      `Save version ${state.version} is not supported (expected ${SAVE_VERSION})`,
    );
  }
  state.damageEvents = []; // transient, never persisted
  state.healEvents = []; // transient, never persisted (req §6.2)
  state.groundItems ??= {}; // tolerate a save written before any loot dropped
  return state;
}
