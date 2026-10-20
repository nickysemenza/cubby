import { ensureMemberParty } from "./fixtures/core";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Section jumps must preserve query feedback and unfinished inputs; visiting
// maintenance must not start diagnostics until the user opens them.
test("settings section navigation preserves drafts, feedback, and diagnostic disclosure", async ({
  page,
}, testInfo) => {
  await ensureMemberParty(page, uniqueName(testInfo, "Synthetic settings"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/settings?purchaseAgent=dispatch_failed");
  const index = page.getByRole("navigation", { name: "Section index" });
  await index
    .getByRole("link", { name: "Purchase merchant routing", exact: true })
    .click();
  await page
    .getByLabel("Merchant label", { exact: true })
    .fill("Synthetic merchant draft");
  await index.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(/purchaseAgent=dispatch_failed#calendar$/);
  await expect(page.locator("#calendar")).toBeFocused();
  await index
    .getByRole("link", { name: "Purchase merchant routing", exact: true })
    .click();
  await expect(page.getByLabel("Merchant label", { exact: true })).toHaveValue(
    "Synthetic merchant draft",
  );
  await index
    .getByRole("link", { name: "Developer / Diagnostics", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Re-run", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Toggle developer tools" }).click();
  await expect(
    page.getByRole("button", { name: "Re-run", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle developer tools" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Jump to:/ }).click();
  await page
    .getByRole("menuitem", { name: "Purchase import agent", exact: true })
    .click();
  await expect(page.locator("#purchase-agent")).toBeFocused();
  await expect(
    page.getByText(/some work could not be dispatched/),
  ).toBeVisible();
  await expect(page.getByLabel("Merchant label", { exact: true })).toHaveValue(
    "Synthetic merchant draft",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("portfolio and cash flow expose their continuous sections through contents navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/projects?view=analytics");
  const openTasks = page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: "Open tasks by project", exact: true });
  const target = await openTasks.getAttribute("href");
  if (!target?.startsWith("#"))
    throw new Error("Portfolio section link has no anchor");
  await openTasks.click();
  await expect(page.locator(target)).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Cost vs estimate", exact: true }),
  ).toBeAttached();

  await gotoAuthenticatedPage(page, "/cash-flow");
  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: "Scenarios", exact: true })
    .click();
  await expect(page.locator("#scenarios")).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Monthly projection", exact: true }),
  ).toBeAttached();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Jump to:/ }).click();
  await page
    .getByRole("menuitem", { name: "Scheduled envelopes", exact: true })
    .click();
  await expect(page.locator("#scheduled-envelopes")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
