import { entityApi } from "./support/entity-api";
import {
  chooseOption,
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
} from "./support/e2e-helpers";
import {
  seedProductPrerequisite,
  seedLocationPrerequisite,
} from "./fixtures/catalog";
import { createEntityFixture } from "./fixtures/core";
import { expect, test } from "./support/e2e-test";

// Required native capability tests own explanation loading/retry, bounded
// evidence, formatting and viewport/focus. This journey owns the real write.
test("a person accepts a data gap as an exception from the explanation and clears it", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 402, height: 874 });
  const name = `Synthetic exception ${Date.now()}`;
  const product = await seedProductPrerequisite(page, {
    name,
    brandId: null,
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
  });
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=table`,
  );
  const row = page.getByRole("listitem").filter({ hasText: name }).first();
  const trigger = row.getByRole("button", {
    name: /How (data )?quality is determined/,
  });
  const popover = page.locator('[data-slot="popover-content"]:visible');
  const check = popover.locator('[data-quality-check="product_brand"]');
  await expect(async () => {
    if (!(await popover.isVisible())) await trigger.click();
    await expect(check).toContainText("Missing data");
  }).toPass();
  await check.getByRole("button", { name: "Accept as…" }).click();
  await chooseOption(page, check.getByLabel("Reason"), "Not applicable");
  await expect(
    check.getByRole("button", { name: "Accept exception" }),
  ).toBeDisabled();
  await check
    .getByLabel("Note")
    .fill(
      "Checked [synthetic catalog](https://example.test/catalog); no brandName is listed.",
    );
  await check.getByRole("button", { name: "Accept exception" }).click();
  await expect(check).toContainText("Accepted exception");
  await expect(
    check.getByRole("link", { name: "synthetic catalog" }),
  ).toHaveAttribute("href", "https://example.test/catalog");
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toBeVisible();
  await check.getByRole("button", { name: "Clear exception" }).click();
  await expect(check).toContainText("Missing data");
  await expect(check.getByRole("button", { name: "Accept as…" })).toBeVisible();
  await check.getByRole("button", { name: "Accept as…" }).click();
  await check
    .getByLabel("Note")
    .fill("Synthetic item has no issued brandName; checked its packaging.");
  await check.getByRole("button", { name: "Accept exception" }).click();
  await expect(check).toContainText("Accepted exception");
  const brand = await createEntityFixture(page, "vendor", {
    name: "Synthetic recorded brand",
  });
  const changed = await entityApi(page.request).update(
    "product",
    product.id,
    { brandId: brand.id },
    { headers: { Origin: baseURL! } },
  );
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await reloadAuthenticatedPage(page, row);
  await expect(async () => {
    if (!(await popover.isVisible())) await trigger.click();
    await expect(check).toContainText(
      "Evidence changed since this exception was recorded",
    );
  }).toPass();
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toBeVisible();
  await check.getByRole("button", { name: "Clear exception" }).click();
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toHaveCount(0);
});
