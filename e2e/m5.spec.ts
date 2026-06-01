// Browser play-tests for M5 (req §2.10, §6.4, §9, §18). Confirms the combat /
// town / horse systems are wired through the page: equipping pulls from the
// global pool and updates the HUD, and a unit can travel to town, buy a horse,
// and then move faster. Mechanics (damage math, trade values, upkeep) live in
// the Vitest sim suites; this layer only asserts the wiring is intact.

import { expect, test } from "@playwright/test";

test("equipping a unit pulls from the pool and updates the HUD", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Stock the equipment pool (live-mutable state in dev) and equip a worker.
  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    s.equipment.sword = 2;
    const id = Number(Object.keys(s.units)[0]);
    g.enqueue({ type: "equip", unitIds: [id], item: "sword", equip: true });
    g.tick(1);
  });

  const equipped = await page.evaluate(() => {
    const s = window.__game!.getState();
    const id = Number(Object.keys(s.units)[0]);
    return { has: s.units[id].equipped.sword, pool: s.equipment.sword };
  });
  expect(equipped.has).toBe(true);
  expect(equipped.pool).toBe(1); // one pulled from the pool of 2

  await expect(page.locator("#hud-equipment")).toContainText("Sword:1");
  expect(errors).toEqual([]);
});

test("a unit travels to town, buys a horse, and then moves faster", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Give the first unit goods worth a horse (4 meat = 20 value) and send it to
  // town to buy one. tick() fast-forwards the long walk + the trade.
  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    // Stock upkeep food so the long fast-forward (which crosses a season
    // boundary) doesn't starve the workers or the freshly-bought horse.
    s.resources.wheat = 20;
    s.resources.meat = 20;
    const id = Number(Object.keys(s.units)[0]);
    s.units[id].carrying = { meat: 4 };
    g.enqueue({ type: "trade", unitIds: [id], sell: { meat: 4 }, buy: {}, buyHorse: true });
    g.tick(30 * 90); // ample time to reach the far town and trade
  });

  await expect
    .poll(() => page.evaluate(() => {
      const s = window.__game!.getState();
      const id = Number(Object.keys(s.units)[0]);
      return s.units[id].horseHp;
    }))
    .toBe(3);

  // The mounted unit now out-runs an un-mounted one over the same move.
  const dist = await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    const ids = Object.keys(s.units).map(Number);
    const rider = ids[0]; // bought a horse above (now standing at the town)
    const foot = ids.find((i) => s.units[i].horseHp === 0)!;
    // Co-locate both at the rider's spot, then march both back toward the
    // hamlet centre (far from town) and step the same number of ticks.
    const start = { x: s.units[rider].x, y: s.units[rider].y };
    s.units[foot].x = start.x;
    s.units[foot].y = start.y;
    s.units[foot].carrying = {};
    const cx = Math.floor(s.map.width / 2);
    const cy = Math.floor(s.map.height / 2);
    g.enqueue({ type: "moveUnits", unitIds: [rider, foot], tx: cx, ty: cy });
    g.tick(60);
    const after = window.__game!.getState();
    const d = (i: number) => Math.hypot(after.units[i].x - start.x, after.units[i].y - start.y);
    return { rider: d(rider), foot: d(foot) };
  });
  expect(dist.foot).toBeGreaterThan(0);
  expect(dist.rider).toBeGreaterThan(dist.foot * 1.4);

  await page.screenshot({ path: "e2e/artifacts/m5-horse.png" });
});

test("the town interface opens at town, stores goods, and trades for a horse (req §18)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Drop the first worker onto the town tile carrying 4 meat (20 value). The
  // marketplace panel auto-opens for an idle unit standing at town.
  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    const id = Number(Object.keys(s.units)[0]);
    s.units[id].x = s.town.x;
    s.units[id].y = s.town.y;
    s.units[id].carrying = { meat: 4 };
    g.tick(1);
  });

  const panel = page.locator("#town-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".town-title")).toContainText("Town Marketplace");

  // Store all 4 meat into town storage (shift-click moves the whole stack).
  const invCol = panel.locator(".town-col", { hasText: "Carrying" });
  await invCol.locator(".town-row", { hasText: "Meat" }).getByRole("button", { name: "Store" })
    .click({ modifiers: ["Shift"] });

  await expect
    .poll(() => page.evaluate(() => window.__game!.getState().townStorage.meat))
    .toBe(4);

  // Now buy a horse, paying with the 4 meat (20 value) sitting in town storage.
  const storeCol = panel.locator(".town-col", { hasText: "Town Storage" });
  const meatOfferPlus = storeCol.locator(".town-row", { hasText: "Meat" })
    .locator(".town-offer-stepper").getByRole("button", { name: "+" });
  for (let i = 0; i < 4; i++) await meatOfferPlus.click();

  await panel.locator(".town-col", { hasText: "For Sale" })
    .locator(".town-row", { hasText: "Horse" }).getByRole("button", { name: "+" }).click();

  await panel.getByRole("button", { name: "Confirm Trade" }).click();

  await expect
    .poll(() => page.evaluate(() => {
      const s = window.__game!.getState();
      const id = Number(Object.keys(s.units)[0]);
      return s.units[id].horseHp;
    }))
    .toBe(3);

  // The horse was paid for out of town storage.
  await expect
    .poll(() => page.evaluate(() => window.__game!.getState().townStorage.meat))
    .toBe(0);

  await page.screenshot({ path: "e2e/artifacts/m5-town.png" });
  expect(errors).toEqual([]);
});
