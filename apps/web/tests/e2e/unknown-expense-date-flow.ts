import { expenseCreateInput, expenseOut } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import { z } from "zod";

import {
  expectViewportBounded,
  gotoAuthenticatedPage,
  readExpense,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const createdExpense = z.object({ item: expenseOut.pick({ id: true }) });
const clearedExpense = z.object({ cost: z.number(), date: z.null() });

/**
 * Clears a fresh expense's date through the bulk dialog in the current layout
 * and returns its id. The server-side refusal contract is asserted once, in
 * the desktop spec.
 */
export async function clearExpenseDatesInBrowser(page: Page, baseURL: string) {
  const name = uniqueName(test.info(), "Undated supplies");
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
  // Below md the list renders as cards (long-press selects); above it, a table.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    const item = page
      .getByRole("list", { name: "Expenses list" })
      .getByRole("listitem")
      .filter({ hasText: name });
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
  // `focus()` is not an actionability-checked action: on a control that is not
  // yet visible and enabled it silently does nothing, and the Space below then
  // lands elsewhere (CI: aria-pressed stayed "false" with no other error). Wait
  // for the control, and prove focus landed, before pressing.
  await expect(unknown).toBeVisible();
  await expect(unknown).toBeEnabled();
  // The dialog moves focus to its own initial target once it has opened; a
  // focus() that lands before that is taken back (CI: "Date unknown" stayed
  // unfocused for the whole expect timeout). Wait until the dialog owns focus.
  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
  await unknown.focus();
  await expect(unknown).toBeFocused();
  await page.keyboard.press("Space");
  await expect(unknown).toHaveAttribute("aria-pressed", "true");
  await expectViewportBounded(page);
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readExpense(page, item.id, clearedExpense)).toMatchObject({
    cost: 0,
    date: null,
  });
  return item.id;
}
