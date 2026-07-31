import { expect, test } from "@playwright/test";
import { addInventory, createLocation, createProduct } from "./e2e-helpers";

test("phone recount keeps the common path to one tap per location", async ({
  page,
}) => {
  const suffix = Date.now();
  const locationName = `Phone recount bin ${suffix}`;
  const productName = `Phone recount item ${suffix}`;

  await createLocation(page, locationName);
  // The detail URL is the public id now, and so is the session's `parent`
  // search param — no uuid ever reaches a URL, query string included.
  const locationCode = page.url().split("/").pop();
  expect(locationCode).toMatch(/^LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  await createProduct(page, productName);
  await addInventory(page, productName, locationName, 1, "each");

  await page.goto(`/inventory/session?parent=${locationCode}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("button", { name: "Previous" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Add something here/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Finish — rest are present (1)" })
    .click();

  await expect(
    page.getByRole("heading", {
      name: `${locationName} recount complete`,
    }),
  ).toBeVisible({ timeout: 15000 });
});
