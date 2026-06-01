// Bootstrap + game loop (req §2.4, §2.7). Wires the simulation core to the
// render/ui/input layers and runs a fixed-timestep update decoupled from the
// render loop. Pause is a loop concern: it stops stepping the sim, but camera
// movement and rendering continue.

import { AUTOSAVE_TICKS, SAVE_KEY, TICKS_PER_SECOND } from "./config/index.js";
import type { Command } from "./game/commands.js";
import { deserialize, serialize } from "./game/persistence.js";
import { createInitialState } from "./game/state.js";
import { update } from "./game/update.js";
import { createRenderer } from "./render/renderer.js";
import type { View } from "./ui/camera.js";
import { createControls, type Controls } from "./ui/controls.js";
import { createHud, type Hud } from "./ui/hud.js";
import { createTownPanel } from "./ui/town.js";
import { createHallPanel } from "./ui/hall.js";
import { createEventOverlay } from "./ui/events.js";
import type { GameState } from "./game/state.js";

const STEP_MS = 1000 / TICKS_PER_SECOND;
const MAX_FRAME_MS = 250; // clamp to avoid a spiral of death after a stall

// Dev-only test seam (req §2.10). Browser play tests drive real input and then
// read real sim state through this hook; it is stripped from production builds
// (the `import.meta.env.DEV` guard dead-code-eliminates in `vite build`).
export interface GameDebugApi {
  getState: () => GameState;
  getView: () => View;
  enqueue: (cmd: Command) => void;
  isPaused: () => boolean;
  // Bulk-advance the sim by `n` ticks immediately, draining the command queue.
  // Test seam so e2e tests don't have to wait real-time for long actions.
  tick: (n: number) => void;
}

declare global {
  interface Window {
    __game?: GameDebugApi;
  }
}

function main(): void {
  const canvasEl = document.getElementById("world");
  if (!(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error("#world canvas not found");
  }
  const canvas: HTMLCanvasElement = canvasEl;

  const renderer = createRenderer(canvas);

  let state = createInitialState(Date.now() >>> 0);
  let paused = false;
  let lastAutosaveTick = 0;
  const commandQueue: Command[] = [];

  // LocalStorage persistence (req §2.5). One slot shared by autosave and the
  // manual Save button; auto-loaded on startup so state survives a reload.
  function saveGame(silent: boolean): void {
    try {
      localStorage.setItem(SAVE_KEY, serialize(state));
      lastAutosaveTick = state.tickCount;
      if (!silent) hud.flash("Saved");
    } catch {
      if (!silent) hud.flash("Save failed");
    }
  }
  function loadGame(): void {
    let json: string | null = null;
    try {
      json = localStorage.getItem(SAVE_KEY);
    } catch {
      json = null;
    }
    if (!json) {
      hud.flash("No save found");
      return;
    }
    try {
      state = deserialize(json);
      lastAutosaveTick = state.tickCount;
      hud.flash("Loaded");
    } catch {
      hud.flash("Load failed");
    }
  }
  function newGame(): void {
    state = createInitialState(Date.now() >>> 0);
    lastAutosaveTick = 0;
    commandQueue.length = 0;
    hud.flash("New game");
  }

  // `controls` is created below but referenced by the HUD's jump callback; the
  // closures run only after both exist, so the forward reference is safe.
  let controls: Controls;
  const hud: Hud = createHud({
    onNew: newGame,
    onSave: () => saveGame(false),
    onLoad: loadGame,
    // an enemy sighting pauses; clicking its toast jumps there and resumes.
    onPause: () => (paused = true),
    onJumpTo: (x, y) => {
      controls.centerOn({ x, y });
      paused = false;
    },
  });

  // Resume the last session if a valid save exists (req §2.5).
  try {
    const existing = localStorage.getItem(SAVE_KEY);
    if (existing) {
      state = deserialize(existing);
      lastAutosaveTick = state.tickCount;
    }
  } catch {
    // ignore an unreadable/incompatible save and keep the fresh game
  }

  const actionPanelEl = document.getElementById("action-panel");
  if (!(actionPanelEl instanceof HTMLElement)) throw new Error("#action-panel not found");

  controls = createControls({
    canvas,
    getState: () => state,
    enqueue: (cmd) => commandQueue.push(cmd),
    onTogglePause: () => (paused = !paused),
    actionPanel: actionPanelEl,
  });

  const townPanelEl = document.getElementById("town-panel");
  if (!(townPanelEl instanceof HTMLElement)) throw new Error("#town-panel not found");
  const townPanel = createTownPanel({
    container: townPanelEl,
    getState: () => state,
    enqueue: (cmd) => commandQueue.push(cmd),
  });

  const hallPanelEl = document.getElementById("hall-panel");
  if (!(hallPanelEl instanceof HTMLElement)) throw new Error("#hall-panel not found");
  const hallPanel = createHallPanel({
    container: hallPanelEl,
    getState: () => state,
    enqueue: (cmd) => commandQueue.push(cmd),
  });

  const eventOverlayEl = document.getElementById("event-overlay");
  const eventDialogEl = document.getElementById("event-dialog");
  if (!(eventOverlayEl instanceof HTMLElement) || !(eventDialogEl instanceof HTMLElement)) {
    throw new Error("#event-overlay / #event-dialog not found");
  }
  const eventOverlay = createEventOverlay({
    overlay: eventOverlayEl,
    dialog: eventDialogEl,
    enqueue: (cmd) => commandQueue.push(cmd),
    onRestart: newGame,
  });

  function syncViewport(): void {
    renderer.resize();
    const rect = canvas.getBoundingClientRect();
    controls.setViewport(rect.width, rect.height);
  }
  syncViewport();
  window.addEventListener("resize", syncViewport);

  let accumulatorMs = 0;
  let lastMs = performance.now();

  function frame(nowMs: number): void {
    const frameMs = Math.min(nowMs - lastMs, MAX_FRAME_MS);
    lastMs = nowMs;

    controls.update(frameMs / 1000);

    // The sim steps through normal play and the live attack-wave fight, but not
    // when paused or once the game is over (req §21.1). A Tax/Misc EndOfYearEvent
    // keeps stepping — update() pauses the whole world internally while the modal
    // is open, but still processes the tax/acknowledge commands sent from it.
    if (!paused && state.phase !== "gameOver") {
      accumulatorMs += frameMs;
      while (accumulatorMs >= STEP_MS) {
        const commands = commandQueue.splice(0, commandQueue.length);
        state = update(state, commands, 1);
        // Hand this step's combat hits to the renderer as floating "-N" toasts
        //. Drained per step so events from intermediate steps in a multi-
        // step frame aren't lost before the next render.
        for (const d of state.damageEvents) renderer.addDamage(d.x, d.y, d.amount, d.target);
        // Heal toasts: green "+N" over each unit that regenerated/season-healed.
        for (const h of state.healEvents) renderer.addHeal(h.x, h.y, h.amount);
        accumulatorMs -= STEP_MS;
      }
      if (state.tickCount - lastAutosaveTick >= AUTOSAVE_TICKS) saveGame(true);
    }

    const view = controls.getView();
    renderer.render(state, view);
    hud.update(state, paused, view);
    townPanel.update(state);
    hallPanel.update(state, view);
    eventOverlay.update(state);
    requestAnimationFrame(frame);
  }

  if (import.meta.env.DEV) {
    window.__game = {
      getState: () => state,
      getView: () => controls.getView(),
      enqueue: (cmd) => commandQueue.push(cmd),
      isPaused: () => paused,
      tick: (n) => {
        const commands = commandQueue.splice(0, commandQueue.length);
        state = update(state, commands, n);
      },
    };
  }

  requestAnimationFrame(frame);
}

main();
