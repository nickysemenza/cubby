import { createEntityFixture } from "./fixtures/core";
import {
  escapeRegExp,
  gotoAuthenticatedPage,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("expense analytics breaks spend down by root Spending Category and charts money flow", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic synthesis");
  const root = await createEntityFixture(page, "spendingCategory", {
    name: `${name} home`,
  });
  const child = await createEntityFixture(page, "spendingCategory", {
    name: `${name} home linens`,
    parentId: root.id,
  });
  const project = await createEntityFixture(page, "project", { name });
  const expense = (label: string, cost: number, spendingCategoryId?: string) =>
    createEntityFixture(page, "expense", {
      name: `${name} ${label}`,
      projectId: project.id,
      date: "2026-09-01",
      cost,
      trade: "other",
      costType: "materials",
      ...(spendingCategoryId ? { spendingCategoryId } : {}),
    });
  await expense("sheets", 60.25, child.id);
  await expense("towels", 15.5, root.id);
  await expense("unsorted", 25.1);

  await gotoAuthenticatedPage(
    page,
    `/expenses?view=analytics&project=${project.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "Spending by Cost Type" }),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: "Money flow", exact: true })
    .click();
  await expect(page.locator("#money-flow")).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`project=${project.id}#money-flow$`));

  // Child spend rolls up to its root; no-category spend stays its own bucket.
  const breakdown = page.getByRole("figure", {
    name: /Net spend by root Spending Category/,
  });
  await expect(breakdown).toHaveAccessibleName(
    new RegExp(`${escapeRegExp(`${name} home`)} \\$76(,|$)`),
  );
  await expect(breakdown).toHaveAccessibleName(/Uncategorized \$25(,|$)/);

  const flow = page.getByRole("figure", { name: /^Money flow of/ });
  await expect(flow).toHaveAccessibleName(/\$101/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Jump to:/ }).click();
  await page
    .getByRole("menuitem", { name: "Monthly Spend", exact: true })
    .click();
  await expect(page.locator("#monthly-spend")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("cash flow spreads a live project's remaining estimate to its end date", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic envelope project");
  const end = new Date();
  end.setMonth(end.getMonth() + 3);
  await createEntityFixture(page, "project", {
    name,
    status: "in_progress",
    costEstimate: 1200,
    endDate: end.toISOString().slice(0, 10),
  });

  await gotoAuthenticatedPage(page, "/cash-flow");
  await expect(
    page.getByRole("figure", { name: /^Projected outflow/ }),
  ).toBeVisible();
  const envelopes = page.getByRole("region", { name: "Scheduled envelopes" });
  await expect(envelopes.getByText(name)).toBeVisible();
});
