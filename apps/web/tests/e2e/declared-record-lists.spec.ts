import type { Page } from "@playwright/test";
import { entityApi } from "./support/entity-api";
import { chooseListView } from "./support/e2e-helpers";
import { formatInstant } from "~/lib/date-format";
import { formatDateSpan, stackedDateSpan } from "~/lib/date-span";
import { householdLocalDate, householdDaysFromNow } from "~/lib/household-date";
import {
  seedLocationPrerequisite,
  seedProductPrerequisite,
} from "./fixtures/catalog";
import { createFixtureGraph } from "./fixtures/core";
import {
  seedPurchaseHeicAttachment,
  seedRecordListDisplayPrerequisite,
} from "./fixtures/finance";
import { seedRunHistoryDefaults } from "./fixtures/photos";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("combined records retain server sorting, pagination, and filters after reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const prefix = `Combined records ${Date.now()}`;
  const location = await seedLocationPrerequisite(page, `${prefix} Alpha`);
  const product = await seedProductPrerequisite(page, {
    name: `${prefix} Zulu`,
  });
  await gotoAuthenticatedPage(
    page,
    `/entities?tab=records&q=${encodeURIComponent(prefix)}&orderBy=name&recordsDirection=asc&pageSize=1`,
  );
  const alpha = page.getByRole("link", {
    name: `${prefix} Alpha`,
    exact: true,
  });
  const zulu = page.getByRole("link", { name: `${prefix} Zulu`, exact: true });
  await expect(alpha).toHaveAttribute("href", `/locations/${location.id}`);
  await expect(zulu).toHaveCount(0);
  await page.getByRole("button", { name: "Sort by Name", exact: true }).click();
  await expect(zulu).toBeVisible();
  await expect(page).toHaveURL(/recordsDirection=desc/);
  await page.getByRole("button", { name: "Sort by Name", exact: true }).click();
  await expect(alpha).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(zulu).toHaveAttribute("href", `/products/${product.id}`);
  await expect(alpha).toHaveCount(0);
  const openFilter = async (label: string) => {
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
  };
  await openFilter("Type");
  await page.getByRole("combobox", { name: "Filter Type" }).fill("Location");
  await page.getByRole("option", { name: "Location", exact: true }).click();
  await page.getByRole("heading", { name: "Entities", exact: true }).click();
  await expect(page).toHaveURL(/kind=location/);
  await expect(alpha).toBeVisible();
  await expect(page).toHaveURL(/page=1/);
  await page.reload();
  await expect(page).toHaveURL(/kind=location/);
  await expect(alpha).toBeVisible();
  await expect(zulu).toHaveCount(0);

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/kind=location/);
  await page.goBack();
  await expect(page).toHaveURL(/kind=location/);
  await expect(alpha).toBeVisible();
  await expect(zulu).toHaveCount(0);
});

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
    expenseRecord.locator('[data-cell-col="dataQuality"] [data-cell-value]'),
  ).toHaveText(/^\d+, /);
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
  await chooseListView(page, "List");
  await page
    .getByRole("button", { name: "Locations view: List", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "List view", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
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

async function seedRecordTotals(page: Page) {
  const tag = `RecordTotals${Date.now()}`;
  await createFixtureGraph(page, async (create) => {
    const vendor = await create("vendor", {
      name: `${tag} vendor`,
      website: "https://example.com",
      orderUrlTemplate: "https://example.com/orders/{orderId}",
      notes: `${tag} vendor notes`,
    });
    const purchase = (suffix: string) =>
      create("purchase", {
        vendorId: vendor.id,
        orderId: `${tag} ${suffix}`,
        date: "2026-09-10",
      });
    const a = await purchase("CopperDebit");
    const b = await purchase("QuartzRefund");
    const c = await purchase("FreeMarker");
    const expense = (name: string, cost: number, purchaseId: string) =>
      create("expense", {
        lineKind: "principal",
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
  });

  return tag;
}

function recordSummaryValue(page: Page, label: string) {
  return page
    .getByText("All matching", { exact: true })
    .locator("..")
    .getByText(label, { exact: true })
    .locator("..")
    .locator("dd");
}

async function expectRecordTotalPages(
  page: Page,
  tag: string,
  path: "purchases" | "expenses",
  sums: Record<string, number>,
) {
  for (const pageNumber of [1, 2]) {
    const response = await entityApi(page.request).list(
      path === "purchases" ? "purchase" : "expense",
      {
        filters: { search: tag },
        pagination: { pageIndex: pageNumber - 1, pageSize: 1 },
      },
    );
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

test("purchase table totals follow the full filtered set after reload", async ({
  page,
}) => {
  const tag = await seedRecordTotals(page);
  const purchaseSearch = page.getByRole("textbox", {
    name: "Search purchases or shortcode",
    exact: true,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoAuthenticatedPage(page, `/purchases?q=${encodeURIComponent(tag)}`);
  await expect(recordSummaryValue(page, "Spend")).toHaveText("$8.00");
  await expect(recordSummaryValue(page, "Expense lines")).toHaveText("4");
  await expect(
    page.getByRole("link", { name: `${tag} CopperDebit`, exact: true }),
  ).toBeVisible();

  await purchaseSearch.fill("QuartzRefund");
  await expect(recordSummaryValue(page, "Spend")).toHaveText("-$7.00");
  await expect(recordSummaryValue(page, "Expense lines")).toHaveText("1");
  await page.reload();
  await expect(recordSummaryValue(page, "Spend")).toHaveText("-$7.00");
  await purchaseSearch.fill("FreeMarker");
  await expect(recordSummaryValue(page, "Spend")).toHaveText("$0.00");
  await expect(recordSummaryValue(page, "Expense lines")).toHaveText("1");

  await expectRecordTotalPages(page, tag, "purchases", {
    expenseTotal: 8,
    expenseCount: 4,
  });
});

test("expense table totals follow the full filtered set", async ({ page }) => {
  const tag = await seedRecordTotals(page);
  await gotoAuthenticatedPage(page, `/expenses?q=${encodeURIComponent(tag)}`);
  await expect(recordSummaryValue(page, "Ledger cost")).toHaveText("$8.00");
  await page
    .getByRole("textbox", { name: "Search expenses or shortcode", exact: true })
    .fill("credit");
  await expect(recordSummaryValue(page, "Ledger cost")).toHaveText("-$12.00");
  await page
    .getByRole("textbox", { name: "Search expenses or shortcode", exact: true })
    .fill("zero");
  await expect(recordSummaryValue(page, "Ledger cost")).toHaveText("$0.00");
  await expectRecordTotalPages(page, tag, "expenses", { cost: 8 });
});

test("purchase and expense card totals follow the full filtered set", async ({
  page,
}) => {
  const tag = await seedRecordTotals(page);
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
    await expect(recordSummaryValue(page, label)).toHaveText(value);
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
  await expect(page.getByText(/^No images yet/)).toHaveCount(0);
  await expect(
    page.locator("#images").getByRole("img", { name: fixture.filename }),
  ).toHaveCount(1);
});

// `presentation.list.initialFilter` on the Run declaration: the list opens
// without ephemeral AI-grouping runs, and clearing the filter (which the URL
// remembers, so a reload keeps it) brings them back.
test("the Run list hides ephemeral runs by default and shows them once cleared", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await seedRunHistoryDefaults(
    page,
    `Run defaults ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, "/runs");
  const table = page.getByRole("table");
  await expect(table).toContainText(fixture.visibleName);
  await expect(table).not.toContainText(fixture.hiddenName);

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(table).toContainText(fixture.hiddenName);
  await expect(table).toContainText(fixture.visibleName);

  await page.reload();
  await expect(table).toContainText(fixture.hiddenName);
});

// Regression: a list with no totals, Sweep or status kept a bordered blank
// band above its records.
test("a list status strip with nothing to show takes no space", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const strip = page.locator("[data-list-status-strip]");
  await gotoAuthenticatedPage(page, "/recipes");
  await expect(strip).toBeAttached();
  await expect(strip).toBeHidden();
  await gotoAuthenticatedPage(page, "/purchases");
  await expect(strip).toBeVisible();
});

test("record dates retain their calendar label with present and future context", async ({
  page,
}) => {
  const prefix = `Date context ${Date.now()}`;
  const today = householdLocalDate();
  const later = householdDaysFromNow(26);
  // Table cells stack the day over its compact distance; the title keeps
  // the full label.
  const current = stackedDateSpan(today, null, today);
  const future = stackedDateSpan(later, null, today);
  const currentDay = current.primary;
  const currentLabel = formatDateSpan(today, null, today);
  const futureDay = future.primary;
  const futureLabel = formatDateSpan(later, null, today);
  const futureContext = future.secondary ?? "";
  const assertDate = async (
    scope: ReturnType<typeof page.locator>,
    label: string,
    day: string,
    context: string,
  ) => {
    const date = scope.getByTitle(label, { exact: true });
    await expect(date.getByText(day, { exact: true })).toBeVisible();
    await expect(date.getByText(context, { exact: true })).toBeVisible();
  };
  const futureTask = await createFixtureGraph(page, async (create) => {
    const project = await create("project", { name: `${prefix} project` });
    await create("task", {
      name: `${prefix} current`,
      projectId: project.id,
      trade: "other",
      due: { start: today, end: null },
    });
    return create("task", {
      name: `${prefix} future`,
      projectId: project.id,
      trade: "other",
      due: { start: later, end: null },
    });
  });
  await gotoAuthenticatedPage(
    page,
    `/tasks?searchQuery=${encodeURIComponent(prefix)}`,
  );
  await expect(
    page.getByRole("textbox", { name: "Search tasks or shortcode" }),
  ).toHaveValue(prefix);
  await assertDate(
    page
      .getByRole("row")
      .filter({ hasText: `${prefix} current` })
      .locator('[data-cell-col="dueDate"]'),
    currentLabel,
    currentDay,
    "today",
  );
  await assertDate(
    page
      .getByRole("row")
      .filter({ hasText: `${prefix} future` })
      .locator('[data-cell-col="dueDate"]'),
    futureLabel,
    futureDay,
    futureContext,
  );
  // Shared date formatting and clipping are owned by date-span.unit.test.ts,
  // list-capabilities.preview.test.tsx and table-density.preview.test.tsx.
  // This journey owns the real list-to-record composition and live timestamp.
  // Full record details expose both date and timestamp without opening a tooltip.
  await gotoAuthenticatedPage(page, `/tasks/${futureTask.id}`);
  await expect(page.getByTitle(futureLabel, { exact: true })).toBeVisible();
  const header = page.getByTestId("detail-spec-plate");
  await expect(header).toContainText("Added");
  const timestamp = header.locator("time");
  await expect(timestamp).toBeVisible();
  const instant = await timestamp.getAttribute("datetime");
  if (!instant) throw new Error("missing created timestamp");
  await expect(timestamp).toContainText(
    formatInstant(instant, "dateShortTime"),
  );
  await expect(timestamp).toContainText(/· (now|.+ ago)/);
  await timestamp.locator("..").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toContainText(
    /\d{2}:\d{2}:\d{2} (PDT|PST|GMT-7|GMT-8)/,
  );
  // A waking page refreshes mounted ages without replacing Date constructors
  // (browser clock emulation can discard TZDate subclass behavior).
  const before = await timestamp.textContent();
  await page.evaluate(() => {
    const later = Date.now() + 120_000;
    Date.now = () => later;
    window.dispatchEvent(new Event("focus"));
  });
  if (!before) throw new Error("missing timestamp label");
  await expect(timestamp).not.toHaveText(before);
});
