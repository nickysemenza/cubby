import {
  createFixture,
  seedPurchaseHeicAttachment,
  seedRecordListDisplayPrerequisite,
  seedRunHistoryDefaults,
  seedVendorDisplayPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Desktop-only: this is the SSR + cross-page navigation proof for declared
// record-list columns. Per-column rendering itself is guarded by
// `entity-display.<entity>.unit.test.tsx`.
test("declared record lists retain identities, relationships and amounts on desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const name = `Record desktop ${Date.now()}`;
  const fixture = await seedRecordListDisplayPrerequisite(page, name);
  await page.goto(`/purchases?q=${encodeURIComponent(fixture.orderId)}`);
  const purchase = page.getByRole("link", {
    name: fixture.orderId,
    exact: true,
  });
  await expect(purchase).toHaveCount(1);
  await expect(purchase).toHaveAttribute(
    "href",
    `/purchases/${fixture.purchase.id}`,
  );
  await expect(
    page
      .getByRole("row")
      .filter({ has: purchase })
      .locator('[data-cell-col="statedTotal"]'),
  ).toHaveText("$12.34");
  await expect(
    page.getByRole("button", {
      name: "Reorder reconciliation column",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByText(`${name} purchase notes`, { exact: true }),
  ).toBeVisible();
  await page.goto(`/expenses?q=${encodeURIComponent(`${name} expense`)}`);
  const expense = page.getByRole("link", {
    name: `${name} expense`,
    exact: true,
  });
  await expect(expense).toHaveCount(1);
  const expenseRecord = page.getByRole("row").filter({ has: expense });
  await expect(
    expenseRecord.getByText("$12.34", { exact: true }),
  ).toBeVisible();
  await expect(
    expenseRecord.getByRole("link", { name: `${name} product`, exact: true }),
  ).toHaveAttribute("href", `/products/${fixture.product.id}`);
  await expect(
    page.getByRole("columnheader").filter({
      has: page.getByRole("button", {
        name: "Reorder purchaseId column",
        exact: true,
      }),
    }),
  ).toContainText("Purchase");
  // The parent relationship is visible in table rows; Children remains hidden
  // by default in the existing display preferences.
  await gotoAuthenticatedPage(
    page,
    `/locations?name=${encodeURIComponent(`${name} shelf`)}`,
  );
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "List view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("columnheader").filter({
      has: page.getByRole("button", {
        name: "Reorder name column",
        exact: true,
      }),
    }),
  ).toContainText("Location");
  await expect(
    page.getByRole("link", { name: `${name} room · room`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.location.id}`);
  await expect(
    page.getByRole("link", { name: `${name} shelf`, exact: true }),
  ).toHaveAttribute("href", `/locations/${fixture.child.id}`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1281);
});

test("purchase and expense totals follow the full filtered set in tables and cards", async ({
  page,
}) => {
  const tag = `RecordTotals${Date.now()}`;
  const vendor = await seedVendorDisplayPrerequisite(page, `${tag} vendor`);
  const purchase = async (suffix: string) =>
    createFixture(page, "purchase", {
      vendorId: vendor.id,
      orderId: `${tag} ${suffix}`,
      date: "2026-09-10",
    });
  const [a, b, c] = [
    await purchase("CopperDebit"),
    await purchase("QuartzRefund"),
    await purchase("FreeMarker"),
  ];
  const expense = (name: string, cost: number, purchaseId: string) =>
    createFixture(page, "expense", {
      name: `${tag} ${name}`,
      cost,
      purchaseId,
      date: "2026-09-10",
      costType: "materials",
      trade: "other",
    });
  await expense("debit A", 20, a.id);
  await expense("credit A", -5, a.id);
  await expense("credit B", -7, b.id);
  await expense("zero C", 0, c.id);

  const summaryValue = (label: string) =>
    page
      .getByText("All matching", { exact: true })
      .locator("..")
      .getByText(label, { exact: true })
      .locator("..")
      .locator("dd");
  const purchaseSearch = page.getByRole("textbox", {
    name: "Search purchases or shortcode",
    exact: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoAuthenticatedPage(page, `/purchases?q=${encodeURIComponent(tag)}`);
  await expect(summaryValue("Spend")).toHaveText("$8.00");
  await expect(summaryValue("Expense lines")).toHaveText("4");
  await expect(
    page.getByRole("link", { name: `${tag} CopperDebit`, exact: true }),
  ).toBeVisible();

  await purchaseSearch.fill("QuartzRefund");
  await expect(summaryValue("Spend")).toHaveText("-$7.00");
  await expect(summaryValue("Expense lines")).toHaveText("1");
  await page.reload();
  await expect(summaryValue("Spend")).toHaveText("-$7.00");
  await purchaseSearch.fill("FreeMarker");
  await expect(summaryValue("Spend")).toHaveText("$0.00");
  await expect(summaryValue("Expense lines")).toHaveText("1");

  await gotoAuthenticatedPage(page, `/expenses?q=${encodeURIComponent(tag)}`);
  await expect(summaryValue("Ledger cost")).toHaveText("$8.00");
  await page
    .getByRole("textbox", { name: "Search expenses or shortcode", exact: true })
    .fill("credit");
  await expect(summaryValue("Ledger cost")).toHaveText("-$12.00");
  await page
    .getByRole("textbox", { name: "Search expenses or shortcode", exact: true })
    .fill("zero");
  await expect(summaryValue("Ledger cost")).toHaveText("$0.00");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, label, value, count] of [
    ["purchases", "Spend", "$8.00", 3],
    ["expenses", "Ledger cost", "$8.00", 4],
  ] as const) {
    await gotoAuthenticatedPage(
      page,
      `/${path}?q=${encodeURIComponent(tag)}&view=shelf`,
    );
    await expect(page.getByTestId("entity-card-grid")).toBeVisible();
    await expect(
      page.getByTestId("entity-card-grid").locator("[data-entity-card]"),
    ).toHaveCount(count);
    await expect(summaryValue(label)).toHaveText(value);
  }

  for (const [path, sums] of [
    ["purchases", { expenseTotal: 8, expenseCount: 4 }],
    ["expenses", { cost: 8 }],
  ] as const) {
    for (const pageNumber of [1, 2]) {
      const response = await page.request.get(`/api/v1/${path}`, {
        params: { search: tag, page: String(pageNumber), pageSize: "1" },
      });
      expect(response.status(), await response.text()).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [expect.any(Object)],
        meta: {
          pageIndex: pageNumber - 1,
          totalCount: path === "purchases" ? 3 : 4,
          sums,
        },
      });
    }
  }
});

test("purchase detail renders an attached HEIC instead of the empty image state", async ({
  page,
}) => {
  const fixture = await seedPurchaseHeicAttachment(
    page,
    `Purchase HEIC ${Date.now()}`,
  );
  await page.goto(`/purchases/${fixture.purchase.id}`);
  await expect(page.getByText("No images", { exact: true })).toHaveCount(0);
  await expect(
    page.locator("#images").getByRole("img", { name: fixture.filename }),
  ).toHaveCount(1);
});

// `presentation.list.initialFilter` on the Run declaration: the history opens
// without ephemeral AI-grouping runs, and clearing the filter (which the URL
// remembers, so a reload keeps it) brings them back.
test("run history hides ephemeral runs by default and shows them once cleared", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await seedRunHistoryDefaults(
    page,
    `Run defaults ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, "/runs");
  const table = page.getByRole("table", { name: "Runs and image jobs" });
  await expect(table).toContainText(fixture.visibleName);
  await expect(table).not.toContainText(fixture.hiddenName);

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(table).toContainText(fixture.hiddenName);
  await expect(table).toContainText(fixture.visibleName);

  await page.reload();
  await expect(table).toContainText(fixture.hiddenName);
});
