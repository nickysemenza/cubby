import {
  seedLocationPrerequisite,
  seedProductCategoryPrerequisite,
} from "./fixtures-catalog";
import { seedLedgerProduct } from "./inventory-flow-fixtures";
import {
  escapeRegExp,
  gotoAuthenticatedPage,
  selectComboboxItem,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("shelf triage stocks with the ledger default, parks in Unknown, and discards", async ({
  page,
}, testInfo) => {
  const shelfName = uniqueName(testInfo, "Triage shelf");
  await seedLocationPrerequisite(page, shelfName);
  const stockName = uniqueName(testInfo, "Triage drill");
  const parkName = uniqueName(testInfo, "Triage caulk");
  const discardName = uniqueName(testInfo, "Triage tape");
  // Bought, never stocked: all three sit in the unlocated view.
  await seedLedgerProduct(page, { name: stockName, bought: 3 });
  await seedLedgerProduct(page, { name: parkName, bought: 2 });
  await seedLedgerProduct(page, { name: discardName, bought: 2 });

  // The queue names every product in the pass, so a stranger's rows in the
  // same database never hide these: jump to each through it.
  const queueItem = (name: string) =>
    page.getByRole("button", { name: new RegExp(escapeRegExp(name)) });
  await gotoAuthenticatedPage(page, "/inventory/triage", queueItem(stockName));

  // Stock: the amount is proposed from the ledger (bought 3, none on a shelf),
  // not the constant 1, and the operator still confirms the write.
  await queueItem(stockName).click();
  await page.getByRole("button", { name: "Stock at a location" }).click();
  const stock = page.getByRole("dialog");
  await selectComboboxItem(
    page,
    stock.getByRole("combobox", { name: "Location" }),
    shelfName,
  );
  await expect(stock.getByLabel("Amount Value")).toHaveValue("3");
  await stock.getByRole("button", { name: /Add 1 to inventory/ }).click();
  await expect(queueItem(stockName)).toContainText("done", {
    timeout: 15000,
  });

  // Park: one click, no dialog, and the pass moves on.
  await queueItem(parkName).click();
  await page.getByRole("button", { name: "Park in Unknown" }).click();
  await expect(page.getByText(`Parked ${parkName} in Unknown.`)).toBeVisible({
    timeout: 15000,
  });
  await expect(queueItem(parkName)).toContainText("done");

  // Discard: the quantity defaults to what the ledger says is outstanding.
  await queueItem(discardName).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  const discard = page.getByRole("dialog");
  await expect(discard.getByLabel("Units discarded")).toHaveValue("2");
  await selectComboboxItem(
    page,
    discard.getByRole("combobox", { name: "Trade" }),
    "Other",
  );
  await discard.getByRole("button", { name: "Discard", exact: true }).click();
  // Settling the last outstanding product ends the pass on its summary; with a
  // stranger's rows still queued, this one shows as done instead.
  await expect(
    page
      .getByRole("heading", { name: "Shelf triage complete" })
      .or(queueItem(discardName).filter({ hasText: "done" })),
  ).toBeVisible({ timeout: 15000 });
});

test("shelf triage bounds the pass by spend and by category", async ({
  page,
}, testInfo) => {
  const category = await seedProductCategoryPrerequisite(page, {
    name: uniqueName(testInfo, "Triage category"),
  });
  const bigName = uniqueName(testInfo, "Triage big");
  const smallName = uniqueName(testInfo, "Triage small");
  const categorizedName = uniqueName(testInfo, "Triage categorized");
  // Net basis is cost x lines: 500 clears the 100 floor, 10 does not.
  await seedLedgerProduct(page, { name: bigName, bought: 1, cost: 500 });
  await seedLedgerProduct(page, { name: smallName, bought: 1 });
  await seedLedgerProduct(page, {
    name: categorizedName,
    bought: 1,
    categoryId: category.id,
  });

  const queueItem = (name: string) =>
    page.getByRole("button", { name: new RegExp(escapeRegExp(name)) });

  await gotoAuthenticatedPage(
    page,
    "/inventory/triage?minSpend=100",
    queueItem(bigName),
  );
  await expect(queueItem(smallName)).toHaveCount(0);
  await expect(queueItem(categorizedName)).toHaveCount(0);

  await gotoAuthenticatedPage(
    page,
    `/inventory/triage?categoryId=${category.id}`,
    queueItem(categorizedName),
  );
  await expect(queueItem(bigName)).toHaveCount(0);
  await expect(queueItem(smallName)).toHaveCount(0);
});

test("the not-on-a-shelf view offers a triage of its rows", async ({
  page,
}) => {
  await gotoAuthenticatedPage(
    page,
    "/products",
    page.getByRole("button", { name: "Actions", exact: true }),
  );
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Saved views/ }).click();
  await page.getByRole("menuitem", { name: /Triage these/ }).click();
  await expect(page).toHaveURL(/\/inventory\/triage$/);
});
