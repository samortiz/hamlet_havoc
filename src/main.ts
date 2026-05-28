// Bootstrap + game loop (req §2.4, §2.7). Wires the simulation core to the
// render/ui/input layers and runs a fixed-timestep update decoupled from the
// render loop. Pause is a loop concern: it stops stepping the sim, but camera
// movement and rendering continue.

import { TICKS_PER_SECOND } from "./config/index.js";
import type { Command } from "./game/commands.js";
import { createInitialState } from "./game/state.js";
import { update } from "./game/update.js";
import { createRenderer } from "./render/renderer.js";
import { createControls } from "./ui/controls.js";
import { createHud } from "./ui/hud.js";

const STEP_MS = 1000 / TICKS_PER_SECOND;
const MAX_FRAME_MS = 250; // clamp to avoid a spiral of death after a stall

function main(): void {
  const canvasEl = document.getElementById("world");
  if (!(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error("#world canvas not found");
  }
  const canvas: HTMLCanvasElement = canvasEl;

  const renderer = createRenderer(canvas);
  const hud = createHud();

  let state = createInitialState(Date.now() >>> 0);
  let paused = false;
  const commandQueue: Command[] = [];

  const controls = createControls({
    canvas,
    getState: () => state,
    enqueue: (cmd) => commandQueue.push(cmd),
    onTogglePause: () => (paused = !paused),
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

    if (!paused) {
      accumulatorMs += frameMs;
      while (accumulatorMs >= STEP_MS) {
        const commands = commandQueue.splice(0, commandQueue.length);
        state = update(state, commands, 1);
        accumulatorMs -= STEP_MS;
      }
    }

    renderer.render(state, controls.getView());
    hud.update(state, paused);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();
