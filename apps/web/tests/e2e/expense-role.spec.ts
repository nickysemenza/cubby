import { expenseOut } from "@cubby/schemas/project";
import { z } from "zod";
import { buildEntity } from "tooling/factories/build";

import { entityApi } from "./entity-api";
import { gotoAuthenticatedPage, readExpense, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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
