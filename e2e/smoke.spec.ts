// Browser smoke test (req §2.10). Verifies the layers the headless sim tests
// can't see: the page boots, the loop ticks, pause freezes it, and real
// mouse/keyboard input flows through to the simulation. Mechanics assertions
// (gather rates, carry caps, upkeep) live in the Vitest sim tests instead.

import { expect, test, type Page } from "@playwright/test";

// Must match config TILE_SIZE (req §3.2). Hardcoded so the test stays in the
// browser-coordinate space without exposing the constant on the debug hook.
const TILE = 32;

async function ticks(page: Page): Promise<number> {
  return page.evaluate(() => window.__game!.getState().tickCount);
}

// First unit's id + tile position and the current camera, used to map a tile to
// the on-screen pixel the player would click.
async function firstUnit(page: Page) {
  return page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    const id = Number(Object.keys(s.units)[0]);
    const u = s.units[id];
    const cam = g.getView().camera;
    return { id, x: u.x, y: u.y, cam };
  });
}

async function screenPoint(page: Page, tileX: number, tileY: number, cam: { x: number; y: number }) {
  const box = await page.locator("#world").boundingBox();
  if (!box) throw new Error("#world canvas has no bounding box");
  return {
    px: box.x + (tileX + 0.5) * TILE - cam.x,
    py: box.y + (tileY + 0.5) * TILE - cam.y,
  };
}

test("boots, ticks, and logs no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();
  await expect(page.locator("#hud-season")).toContainText("Year 1");

  const before = await ticks(page);
  await page.waitForTimeout(500);
  expect(await ticks(page)).toBeGreaterThan(before);

  await page.screenshot({ path: "e2e/artifacts/world.png" });
  expect(errors).toEqual([]);
});

test("Space pauses and resumes the simulation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  await page.keyboard.press("Space");
  await expect(page.locator("#hud-paused")).toBeVisible();
  const frozen = await ticks(page);
  await page.waitForTimeout(300);
  expect(await ticks(page)).toBe(frozen);
  expect(await page.evaluate(() => window.__game!.isPaused())).toBe(true);

  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  expect(await ticks(page)).toBeGreaterThan(frozen);
});

test("left-click selects a unit and right-click moves it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  const unit = await firstUnit(page);

  // Left-click the unit's tile → it becomes selected.
  const at = await screenPoint(page, unit.x, unit.y, unit.cam);
  await page.mouse.click(at.px, at.py);
  await expect
    .poll(() => page.evaluate(() => window.__game!.getView().selection))
    .toContain(unit.id);

  // Right-click a clear tile a few steps away (inside the grass clearing) →
  // the selected unit pathfinds there.
  const destX = Math.round(unit.x) + 3;
  const destY = Math.round(unit.y);
  const dest = await screenPoint(page, destX, destY, unit.cam);
  await page.mouse.click(dest.px, dest.py, { button: "right" });

  await expect
    .poll(
      () =>
        page.evaluate(
          (start) => {
            const u = window.__game!.getState().units[start.id];
            return Math.abs(u.x - start.x) + Math.abs(u.y - start.y);
          },
          { id: unit.id, x: unit.x, y: unit.y },
        ),
      { timeout: 6000 },
    )
    .toBeGreaterThan(1);
});
