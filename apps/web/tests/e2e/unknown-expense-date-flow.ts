import { expenseCreateInput, expenseOut } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

const createdExpense = z.object({ item: expenseOut.pick({ id: true }) });

export async function clearExpenseDatesInBrowser(page: Page, baseURL: string) {
  const name = `Undated supplies ${Date.now()}`;
  const response = await page.request.post("/api/v1/expenses", {
    headers: { Origin: baseURL },
    data: expenseCreateInput.parse({
      name,
      cost: 0,
      date: "2026-01-02",
      costType: "materials",
      trade: "other",
    }),
  });
  expect(response.status(), await response.text()).toBe(201);
  const { item } = createdExpense.parse(await response.json());
  await gotoAuthenticatedPage(page, `/expenses?q=${encodeURIComponent(name)}`);
  if (await page.getByRole("list", { name: "Expenses list" }).isVisible()) {
    const item = page.getByRole("listitem").filter({ hasText: name });
    await item
      .getByRole("link", { name, exact: true })
      .dispatchEvent("touchstart");
    await expect(
      item.getByRole("checkbox", { name: "Select item" }),
    ).toBeChecked();
    await item.dispatchEvent("touchend");
  } else {
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("checkbox", { name: "Select row" })
      .click();
  }
  await page
    .locator("[data-bulk-action-bar]")
    .getByRole("button", { name: "Bulk edit...", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const unknown = dialog.getByRole("button", {
    name: "Date unknown",
    exact: true,
  });
  await unknown.focus();
  await page.keyboard.press("Space");
  await expect(unknown).toHaveAttribute("aria-pressed", "true");
  await expectViewportBounded(page);
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const updated = await page.request.get(`/api/v1/expenses/${item.id}`);
  expect(await updated.json()).toMatchObject({ cost: 0, date: null });
  const refused = await page.request.patch(`/api/v1/expenses/${item.id}`, {
    headers: { Origin: baseURL },
    data: { cost: 12 },
  });
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain("A date is required");
}
