import { seedInventoryPrerequisites } from "./e2e-fixtures";
import { gotoAuthenticatedPage, reloadAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("recount is current-pass scoped, resumable, and completes with a summary", async ({
  page,
}) => {
  const suffix = Date.now();
  const locationName = `Recount bin ${suffix}`;
  const firstProduct = `Recount wrench ${suffix}`;
  const secondProduct = `Recount clamp ${suffix}`;

  const { location } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [
      { name: firstProduct, quantity: 1, unit: "each" },
      { name: secondProduct, quantity: 1, unit: "each" },
    ],
  });
  // The public id is also the session's `parent` search param — no uuid ever
  // reaches a URL, query string included.
  const locationCode = location.id;
  expect(locationCode).toMatch(/^LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);

  const addButton = page.getByRole("button", { name: /Add something here/ });
  await gotoAuthenticatedPage(
    page,
    `/inventory/session?parent=${locationCode}`,
    addButton,
  );
  await expect(page.getByRole("combobox", { name: "manual add" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Decrease quantity" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: `Change ${firstProduct}` }).click();
  await expect(
    page.getByRole("button", { name: "Decrease quantity" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(
    page.getByRole("main").getByText(firstProduct, { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Finish — rest are present (2)" })
    .click();

  await expect(
    page.getByRole("heading", {
      name: `${locationName} recount complete`,
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("1 location saved · 2 items confirmed"),
  ).toBeVisible();

  const completedHeading = page.getByRole("heading", {
    name: `${locationName} recount complete`,
  });
  await reloadAuthenticatedPage(page, completedHeading);

  await page
    .getByRole("button", { name: `Recount ${locationName} again` })
    .click();
  await expect(
    page.getByRole("main").getByText(firstProduct, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish — rest are present (2)" }),
  ).toBeVisible();
});
