import { entityApi } from "./entity-api";
import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  inlineExplanation,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEntityFixture } from "./fixtures-core";
import { seedWardrobePrerequisites } from "./fixtures-catalog";

// Allocation evidence must name the contributing items and preserve each item's
// override/fallback order. A null mixed result must never read as an unset trade.
test("explains allocated trades with expandable contributor precedence", async ({
  page,
  baseURL,
}) => {
  const { id: project } = await createEntityFixture(page, "project", {
    name: "Synthetic evidence renovation",
    defaultTrade: "building",
  });
  const { id: vendor } = await createEntityFixture(page, "vendor", {
    name: "Synthetic evidence supplier",
  });
  const { id: purchase } = await createEntityFixture(page, "purchase", {
    vendorId: vendor,
    date: "2026-09-01",
    defaultProjectId: project,
    defaultTrade: "plumbing",
  });
  const { id: cable } = await createEntityFixture(page, "expense", {
    name: "Synthetic evidence cable",
    purchaseId: purchase,
    date: "2026-09-01",
    cost: 20,
    costType: "materials",
    trade: "electrical",
  });
  await createEntityFixture(page, "expense", {
    name: "Synthetic evidence valve",
    purchaseId: purchase,
    date: "2026-09-01",
    cost: 10,
    costType: "materials",
    trade: null,
  });
  const { id: fee } = await createEntityFixture(page, "expense", {
    name: "Synthetic evidence fee",
    purchaseId: purchase,
    date: "2026-09-01",
    cost: 3,
    costType: "services",
    lineKind: "fee",
    trade: null,
  });
  await gotoAuthenticatedPage(page, `/expenses/${fee}`);
  const trigger = page.getByRole("button", {
    name: "How trade is determined",
    exact: true,
  });
  await trigger.click();
  const panel = await inlineExplanation(page, trigger);
  await expect(panel.getByText("Mixed", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Resolution order", exact: true }),
  ).toBeVisible();
  const contributor = panel
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Synthetic evidence cable" }),
    })
    .first();
  await contributor.locator("summary").click();
  await expect(contributor.getByText("Overridden above").first()).toBeVisible();
  await expect(
    contributor.getByText("Electrical", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    contributor.getByText("Plumbing", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportBounded(page);
  await page.keyboard.press("Escape");
  // Changing one principal makes the allocation single-valued; the explanation
  // must refresh its outcome without materializing the inherited trade.
  const response = await entityApi(page.request).update(
    "expense",
    cable,
    { trade: null },
    { headers: { Origin: baseURL! } },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  await gotoAuthenticatedPage(page, `/expenses/${fee}`);
  await trigger.click();
  const refreshed = await inlineExplanation(page, trigger);
  await expect(refreshed.getByText("Mixed", { exact: true })).toHaveCount(0);
  await expect(
    refreshed.getByText("Plumbing", { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const projectTrigger = page.getByRole("button", {
    name: "How project is determined",
    exact: true,
  });
  await projectTrigger.click();
  const projects = await inlineExplanation(page, projectTrigger);
  await expect(projects.getByText("Allocated", { exact: true })).toBeVisible();
  await expect(
    projects.locator("summary").filter({ hasText: "Synthetic evidence cable" }),
  ).toContainText("Synthetic evidence renovation");
});

// The owner rollup already has readable record rows; rendering its raw resolved
// list a second time exposes nested Label/Ref fields and squeezes the popover.
test("shows owner rollup evidence once without nested wire fields", async ({
  page,
}, testInfo) => {
  const fixture = await seedWardrobePrerequisites(
    page,
    "Synthetic owner evidence",
  );
  await gotoAuthenticatedPage(page, `/products/${fixture.product.id}`);
  const trigger = page.getByRole("button", {
    name: "How owner is determined",
    exact: true,
  });
  await trigger.click();
  const panel = await inlineExplanation(page, trigger);
  await expect(
    panel
      .locator("summary")
      .filter({ hasText: "Synthetic owner evidence drawer" }),
  ).toBeVisible();
  await expect(
    panel
      .getByText("Synthetic owner evidence owner", { exact: true })
      .filter({ visible: true }),
  ).toHaveCount(1);
  await expect(
    panel
      .getByText("Synthetic owner evidence other", { exact: true })
      .filter({ visible: true }),
  ).toHaveCount(1);
  await expect(panel.getByText("Entity Kind", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Inherited", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("owner-evidence-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("owner-evidence-phone.png"),
  });
  const ownerDetails = panel
    .locator("details")
    .filter({
      has: page
        .locator("summary")
        .filter({ hasText: "Synthetic owner evidence drawer" }),
    })
    .first();
  await ownerDetails.locator("summary").click();
  await expect(
    ownerDetails.locator('[data-record-list="timeline"]').first(),
  ).toBeVisible();
});
