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
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("checkbox", { name: "Select row" })
    .click();
  await recordProgrammaticFocus(page);
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
  // Still flaky on CI after the waits above (focus leaves and never returns),
  // and not reproducible locally: on failure, name who holds focus and which
  // programmatic focus() calls ran, so the next occurrence carries the thief.
  await expect(unknown)
    .toBeFocused()
    .catch(async (error: Error) => {
      throw new Error(`${error.message}\n${await focusReport(page)}`);
    });
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

async function recordProgrammaticFocus(page: Page) {
  await page.evaluate(() => {
    const log: string[] = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      const label =
        this.getAttribute("aria-label") ?? this.textContent?.slice(0, 40);
      const stack = new Error().stack?.split("\n").slice(2, 6).join(" | ");
      log.push(`${this.tagName} "${label ?? ""}" <- ${stack ?? "?"}`);
      if (log.length > 8) log.shift();
      document.documentElement.dataset.e2eFocusLog = JSON.stringify(log);
      original.call(this, options);
    };
  });
}

const focusLog = z.array(z.string());

async function focusReport(page: Page) {
  const { active, log } = await page.evaluate(() => ({
    active: document.activeElement?.outerHTML.slice(0, 200) ?? "none",
    log: document.documentElement.dataset.e2eFocusLog ?? "[]",
  }));
  return [
    `Focused instead: ${active}`,
    "Recent focus() calls:",
    ...focusLog.parse(JSON.parse(log)),
  ].join("\n");
}
