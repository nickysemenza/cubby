import { eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getFixtureDb } from "./fixtures-core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedHouseholdRuntime } from "./fixtures-household";

test.beforeAll(async ({ e2eRuntime }) => {
  test.setTimeout(120_000);
  await seedHouseholdRuntime(e2eRuntime);
});

// Stored-graph, idempotence and external-storage failures belong to the
// PostgreSQL fixture contract. This journey covers the browser read boundary.
test("connected household supports wardrobe screenshots and garden exploration", async ({
  page,
}, testInfo) => {
  const db = getDb(getFixtureDb());
  const shirt = await db.query.product.findFirst({
    where: eq(schema.product.name, "Cedar Cotton Field Shirt"),
  });
  const garden = await db.query.location.findFirst({
    where: eq(schema.location.name, "Cedar Raised Beds"),
  });
  if (!shirt || !garden)
    throw new Error("Shared exploration household is missing curated records");
  await gotoAuthenticatedPage(page, `/products/${shirt.shortcode}`);
  await expect(
    page.getByRole("heading", { name: shirt.name, exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("link", {
        name: `${shirt.name} · Cedar Wardrobe`,
        exact: true,
      })
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  const screenshot = testInfo.outputPath("synthetic-household-wardrobe.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("Synthetic household wardrobe", {
    path: screenshot,
    contentType: "image/png",
  });
  await gotoAuthenticatedPage(page, `/locations/${garden.shortcode}#work`);
  await expect(page.locator("#plantings")).toBeVisible();
  await expect(page.locator("#garden-entries")).toBeVisible();
  await expect(
    page
      .locator("#plantings")
      .getByText("Cedar Lettuce cultivar", { exact: true })
      .first(),
  ).toBeVisible();
});
