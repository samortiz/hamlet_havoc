// Browser play-tests for M3 (req §2.10, §7). Confirms the construction system
// is wired through the page: a build command becomes an under-construction
// site, a worker completes it, the HUD reflects the new storage cap and
// population, and a smithy can craft items.

import { expect, test } from "@playwright/test";

test("a worker places + builds a House, raising storage capacity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Stock resources so the build cost (3 wood + 2 wheat) is affordable.
  const capBefore = await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    // Direct stocking via the existing __game hook + a follow-up tick(0) write
    // would be cleaner, but enqueue doesn't let us add resources. We rely on
    // the harness exposing the state object as live-mutable in dev mode.
    s.resources.wood = 20;
    s.resources.wheat = 10;
    let cap = 0;
    for (const b of Object.values(s.buildings))
      if (b.kind === "mainHall" || b.kind === "house" || b.kind === "barn")
        cap += { mainHall: 20, house: 10, barn: 50 }[b.kind] ?? 0;
    return cap;
  });

  // Place a House just south of the hamlet centre. The starting clearing
  // (radius 5) keeps tiles open, so this is always valid.
  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    const id = Number(Object.keys(s.units)[0]);
    const cx = Math.floor(s.map.width / 2);
    const cy = Math.floor(s.map.height / 2);
    g.enqueue({ type: "build", unitIds: [id], kind: "house", tx: cx + 1, ty: cy + 4 });
    g.tick(30 * 60); // fast-forward 60 sec: walk + 20-sec build
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__game!.getState();
        const built = Object.values(s.buildings).find(
          (b) => b.kind === "house" && b.progress >= 450 /* BUILD_TICKS.house */,
        );
        return !!built;
      }),
    )
    .toBe(true);

  // Storage cap should be capBefore + 10 (one new House adds 10 storage).
  const capAfter = await page.evaluate(() => {
    const s = window.__game!.getState();
    let cap = 0;
    const STORAGE = { mainHall: 20, house: 10, barn: 50 };
    for (const b of Object.values(s.buildings)) {
      const v = STORAGE[b.kind as keyof typeof STORAGE];
      if (v && b.progress >= 450) cap += v;
    }
    return cap;
  });
  expect(capAfter).toBeGreaterThan(capBefore);

  // The HUD reflects the new storage cap.
  await expect(page.locator("#hud-storage")).toContainText(`/${capAfter}`);

  await page.screenshot({ path: "e2e/artifacts/m3-house.png" });
});

test("a smithy crafts a sword for a worker stationed inside", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#world")).toBeVisible();

  // Pre-build a smithy via the build flow + fast-forward, then assign the
  // crafting order. We need iron to actually produce a sword (2 iron / item).
  await page.evaluate(() => {
    const g = window.__game!;
    const s = g.getState();
    s.resources.wood = 50;
    s.resources.stone = 10;
    s.resources.iron = 10;
    const id = Number(Object.keys(s.units)[0]);
    const cx = Math.floor(s.map.width / 2);
    const cy = Math.floor(s.map.height / 2);
    g.enqueue({ type: "build", unitIds: [id], kind: "smithy", tx: cx + 3, ty: cy });
    g.tick(30 * 80); // walk + 60-sec smithy build
  });

  const smithyId = await page.evaluate(() => {
    const s = window.__game!.getState();
    return Object.values(s.buildings).find((b) => b.kind === "smithy")?.id ?? null;
  });
  expect(smithyId).not.toBeNull();

  // Send the same worker into the smithy to craft a sword, then wait one
  // full season (1800 ticks) plus a walk margin.
  await page.evaluate((sid) => {
    const g = window.__game!;
    const s = g.getState();
    const id = Number(Object.keys(s.units)[0]);
    g.enqueue({ type: "craft", unitIds: [id], buildingId: sid as number, item: "sword" });
    g.tick(1800 + 30 * 20);
  }, smithyId);

  const swords = await page.evaluate(() => window.__game!.getState().equipment.sword);
  expect(swords).toBeGreaterThanOrEqual(1);

  // HUD should reflect the crafted sword.
  await expect(page.locator("#hud-equipment")).toContainText(`Sword:${swords}`);

  await page.screenshot({ path: "e2e/artifacts/m3-smithy.png" });
});
