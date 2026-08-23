import { expect, test } from "@playwright/test";
import { addInventory, createLocation, createProduct } from "./e2e-helpers";

/**
 * The camera cannot be driven from a test, so both flows go through the
 * sweep's manual "Can't scan? Type a code" field — which exists on its own
 * merit (smudged barcodes) and happens to be the seam a test can reach.
 */

async function openSweep(page: import("@playwright/test").Page, code: string) {
  await page.goto(`/locations/${code}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Sweep", exact: true }).click();
  return page.getByRole("textbox", {
    name: "Enter a barcode, ISBN, or Cubby code",
  });
}

test("sweeping pulls a stray in, then confirms it without inflating", async ({
  page,
}) => {
  const suffix = Date.now();
  const oldRoom = `Sweep old room ${suffix}`;
  const shelf = `Sweep shelf ${suffix}`;
  const productName = `Sweep book ${suffix}`;

  await createLocation(page, oldRoom);
  await createLocation(page, shelf);
  const shelfCode = page.url().split("/").pop();
  expect(shelfCode).toMatch(/^LOC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);

  await createProduct(page, productName);
  const productCode = page.url().split("/").pop();
  expect(productCode).toMatch(/^PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);

  // It lives in the old room. Sweeping the shelf should offer to bring it over.
  await addInventory(page, productName, oldRoom, 1, "each");

  const codeField = await openSweep(page, shelfCode!);
  await codeField.fill(productCode!);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Nothing was written — the stray waits for one decision at the end.
  await expect(page.getByText("Living elsewhere")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText(oldRoom, { exact: false })).toBeVisible();

  const moveButton = page.getByRole("button", {
    name: new RegExp(`Move it into ${shelf}`),
  });
  await moveButton.click();
  await expect(page.getByText("Living elsewhere")).toBeHidden({
    timeout: 15000,
  });

  // Second sweep of the same shelf: it is here now, so it confirms. This is the
  // property that makes re-sweeping safe — an increment here would double a
  // bookshelf, and ISBN-created products carry no expectedQuantity to catch it.
  const secondField = await openSweep(page, shelfCode!);
  await secondField.fill(productCode!);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("0 added · 1 confirmed")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("Living elsewhere")).toBeHidden();

  // One row, still one unit.
  await page.goto(`/locations/${shelfCode}`);
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("main").getByText(productName, { exact: true }),
  ).toHaveCount(1);
});

test("sweeping an empty location stocks it, which a recount cannot do", async ({
  page,
}) => {
  const suffix = Date.now();
  const shelf = `Sweep empty shelf ${suffix}`;
  const productName = `Sweep new item ${suffix}`;

  await createProduct(page, productName);
  const productCode = page.url().split("/").pop();

  // Never stocked anywhere, and the shelf has no contents — so it is not a
  // recount stop at all (`directItemCount > 0`). The sweep is the only way in.
  await createLocation(page, shelf);
  const shelfCode = page.url().split("/").pop();

  const codeField = await openSweep(page, shelfCode!);
  await codeField.fill(productCode!);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("1 added · 0 confirmed")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("Living elsewhere")).toBeHidden();
});
