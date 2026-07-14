import { expect, test } from "@playwright/test";
import { addInventory, createLocation, createProduct } from "./e2e-helpers";

test("recount is current-pass scoped, resumable, and completes with a summary", async ({
  page,
}) => {
  const suffix = Date.now();
  const locationName = `Recount bin ${suffix}`;
  const firstProduct = `Recount wrench ${suffix}`;
  const secondProduct = `Recount clamp ${suffix}`;

  await createLocation(page, locationName);
  const locationId = page.url().split("/").pop();
  expect(locationId).toBeTruthy();
  await createProduct(page, firstProduct);
  await createProduct(page, secondProduct);
  await addInventory(page, firstProduct, locationName, 1, "each");
  await addInventory(page, secondProduct, locationName, 1, "each");

  await page.goto(`/inventory/session?parentId=${locationId}`);
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("button", { name: /Add something here/ }),
  ).toBeVisible();
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

  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", {
      name: `${locationName} recount complete`,
    }),
  ).toBeVisible();

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
