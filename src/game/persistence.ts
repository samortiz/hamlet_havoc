// Save format = JSON serialization of the central state (req §2.5). Because the
// state is plain, id-based data with no cycles (req §2.6), this is a plain
// stringify/parse. LocalStorage wiring (auto-save / manual save) lands in M2;
// these pure helpers are what that layer will build on.

import { SAVE_VERSION, type GameState } from "./state.js";

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string): GameState {
  const state = JSON.parse(json) as GameState;
  if (state.version !== SAVE_VERSION) {
    throw new Error(
      `Save version ${state.version} is not supported (expected ${SAVE_VERSION})`,
    );
  }
  return state;
}
