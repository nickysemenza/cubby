import { chooseOption, gotoAuthenticatedPage } from "./support/e2e-helpers";
import { createFixtureGraph } from "./fixtures/core";
import { expect, test } from "./support/e2e-test";

// Required native capability tests own explanation loading/retry, bounded
// evidence, formatting and viewport/focus. This journey owns the real write.
test("a person accepts a data gap as an exception, then clears it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 402, height: 874 });
  const name = `Synthetic exception ${Date.now()}`;
  await createFixtureGraph(page, async (create) => {
    const product = await create("product", { name, brandId: null });
    const location = await create("location", {
      name: `${name} shelf`,
      type: "room",
      parentId: null,
    });
    await create("inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "each" },
    });
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
  const openCurrentExplanation = async () => {
    if (!(await popover.isVisible())) await trigger.click();
    const refresh = popover.getByRole("button", {
      name: "Refresh value and explanation",
    });
    if (await refresh.isVisible()) await refresh.click();
  };
  await expect(async () => {
    await openCurrentExplanation();
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
  // The durable decision is current even while the published checks await the bulk pass.
  await expect(async () => {
    await openCurrentExplanation();
    await expect(check).toContainText("Recorded as Not applicable");
  }).toPass();
  await expect(
    check.getByRole("link", { name: "synthetic catalog" }),
  ).toHaveAttribute("href", "https://example.test/catalog");
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toBeVisible();
  await check.getByRole("button", { name: "Clear exception" }).click();
  await expect(
    check.getByRole("button", { name: "Clear exception" }),
  ).toHaveCount(0);
});
