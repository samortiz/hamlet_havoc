// Browser play-tests for the M2 worker loop and persistence (req §2.10).
// Uses the dev-only `window.__game` hook for sim state and the new `tick(n)`
// fast-forward seam so a full gather→deposit cycle (~3 sim minutes) fits in
// a real-time test in milliseconds.

import { expect, test } from "@playwright/test";

test("a worker chops, walks back, and deposits wood into the pool", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    const id = Number(Object.keys(s.units)[0]);
    const w = s.units[id];

    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let y = 0; y < s.map.height; y++) {
      for (let x = 0; x < s.map.width; x++) {
        if (s.map.tiles[y * s.map.width + x] === "forest") {
          const d = (x - w.x) ** 2 + (y - w.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (!best) throw new Error("no forest tile on this map");

    g.enqueue({ type: "gather", unitIds: [id], tx: best.x, ty: best.y });
    g.tick(30 * 200); // fast-forward 200 sec of sim time
  });

  expect(
    await page.evaluate(() => window.__game!.getState().resources.wood),
  ).toBeGreaterThan(0);

  // Confirm the HUD reflects the deposit.
  await expect(page.locator("#hud-resources")).toContainText("Wood");
  await expect(page.locator("#hud-storage")).toContainText(/Total \d+\/40/);

  await page.screenshot({ path: "e2e/artifacts/m2-gather.png" });
});

test("manual Save survives a page reload (req §2.5)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Advance the sim then capture a distinctive value to check across reload.
  await page.evaluate(() => window.__game!.tick(150));
  const savedTick = await page.evaluate(() => window.__game!.getState().tickCount);
  expect(savedTick).toBeGreaterThan(0);

  await page.locator("#btn-save").click();
  await expect(page.locator("#hud-toast")).toContainText("Saved");

  await page.reload();
  await expect(page.locator("#world")).toBeVisible();

  // The auto-load on startup restores the saved state; subsequent ticks may
  // advance it further, so assert "at least as far as we saved".
  const restoredTick = await page.evaluate(() => window.__game!.getState().tickCount);
  expect(restoredTick).toBeGreaterThanOrEqual(savedTick);
});
