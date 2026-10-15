import { expenseOut } from "@cubby/schemas/project";
import { z } from "zod";
import { buildEntity } from "tooling/factories/build";

import { entityApi } from "./support/entity-api";
import {
  gotoAuthenticatedPage,
  readExpense,
  uniqueName,
  waitForFormHydration,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// An unresolved role must remain visible and retain its amount after manual resolution.
test("unclassified Expense explains its role gap and resolution preserves money", async ({
  page,
  baseURL,
}) => {
  const name = uniqueName(test.info(), "Unresolved receipt role");
  const response = await entityApi(page.request).create(
    "expense",
    buildEntity("expense", {
      name,
      cost: -2.13,
      date: "2026-01-02",
      lineKind: "unclassified",
      productId: null,
      productQuantity: null,
      projectId: null,
      spendingCategoryId: null,
      costType: "materials",
      trade: "other",
    }),
    { headers: { Origin: baseURL! } },
  );
  expect(response.status(), await response.text()).toBe(200);
  const { item } = z
    .object({ item: expenseOut.pick({ id: true }) })
    .parse(await response.json());
  await gotoAuthenticatedPage(page, `/expenses?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("$2.13");
  await row.hover();
  await row
    .getByRole("button", { name: /How (data )?quality is determined/ })
    .click();
  const explanation = page.locator('[data-slot="popover-content"]:visible');
  await expect(explanation).toContainText("Receipt role");
  await expect(
    explanation.locator('[data-quality-check="expense_receipt_role"]'),
  ).toContainText("Missing data");
  await page.keyboard.press("Escape");
  const resolved = await entityApi(page.request).update("expense", item.id, {
    lineKind: "principal",
  });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  const stored = await readExpense(
    page,
    item.id,
    expenseOut.pick({ cost: true, lineKind: true, dataQuality: true }),
  );
  expect(stored.cost).toBe(-2.13);
  expect(stored.lineKind).toBe("principal");
  expect(stored.dataQuality.gaps.map((gap) => gap.check)).not.toContain(
    "expense_receipt_role",
  );
});

// Pending inference must not block the Product assignment that establishes principal.
test("capture keeps pending role controls available and saves an explicitly selected Product", async ({
  page,
}) => {
  const name = uniqueName(test.info(), "Captured principal item");
  const productName = uniqueName(test.info(), "Synthetic capture product");
  const created = await entityApi(page.request).create(
    "product",
    buildEntity("product", { name: productName }),
  );
  expect(created.ok(), await created.text()).toBe(true);
  const product = z
    .object({ item: z.object({ id: z.string() }) })
    .parse(await created.json()).item;
  await gotoAuthenticatedPage(page, "/expenses?create=true");
  await waitForFormHydration(page);
  const dialog = page.getByRole("dialog");
  const role = dialog.getByRole("combobox", {
    name: /Line kind|Receipt role/i,
  });
  const productPicker = dialog.getByRole("combobox", {
    name: "Product",
    exact: true,
  });
  await expect(productPicker).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toBeVisible();
  await role.click();
  await page.getByRole("option", { name: /^Tax(?:$| )/ }).click();
  await expect(productPicker).toHaveCount(0);
  await role.click();
  await page
    .getByRole("option", { name: "Decide from receipt evidence", exact: true })
    .click();
  await selectComboboxItem(page, productPicker, productName);
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByLabel("Cost", { exact: true }).fill("2.13");
  await dialog.getByLabel("Date", { exact: true }).fill("2026-01-02");
  await dialog.getByRole("combobox", { name: "Trade", exact: true }).click();
  await page.getByRole("option", { name: /^Other(?:$| )/ }).click();
  await dialog.getByRole("button", { name: /^Create$/ }).click();
  await expect(dialog).not.toBeVisible();
  const listed = await entityApi(page.request).list("expense");
  expect(listed.ok(), await listed.text()).toBe(true);
  const rows = z
    .object({
      items: z.array(
        expenseOut.pick({
          name: true,
          lineKind: true,
          productId: true,
          cost: true,
        }),
      ),
    })
    .parse(await listed.json()).items;
  expect(rows.find((row) => row.name === name)).toMatchObject({
    lineKind: "principal",
    productId: product.id,
    cost: 2.13,
  });
});
