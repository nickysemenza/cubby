import { seedProductPrerequisite } from "./fixtures-catalog";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// CI installs only Chromium, so the phone layout is a Chromium phone viewport.
test.use({
  viewport: { width: 402, height: 874 },
  isMobile: true,
  hasTouch: true,
});

test("image-free records retain identity and a usable detail path on a phone", async ({
  page,
}, testInfo) => {
  const name = `E2E field guide record ${Date.now()}`;
  const product = await seedProductPrerequisite(page, { name });

  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}&view=shelf`,
  );
  const card = page.locator("[data-entity-card]").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByText("Field guide", { exact: true })).toBeVisible();
  await expect(card.getByText("Product", { exact: true })).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("phone-shelf.png") });

  await card
    .getByRole("link", { name: `Open detail page for ${name}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("phone-detail.png") });
});
