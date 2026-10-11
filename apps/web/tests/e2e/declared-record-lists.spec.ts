import { chooseListView } from "./e2e-helpers";
import { formatCalendarDay } from "~/lib/date-format";
import { householdLocalDate, householdDaysFromNow } from "~/lib/household-date";
import {
  seedVendorDisplayPrerequisite,
  seedLocationPrerequisite,
  seedProductPrerequisite,
} from "./fixtures-catalog";
import { createFixture } from "./fixtures-core";
import {
  seedPurchaseHeicAttachment,
  seedRecordListDisplayPrerequisite,
} from "./fixtures-finance";
import { seedRunHistoryDefaults } from "./fixtures-photos";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("combined records retain server sorting, pagination, and filters after reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const prefix = `Combined records ${Date.now()}`;
  const location = await seedLocationPrerequisite(page, `${prefix} Alpha`);
  const product = await seedProductPrerequisite(page, {
    name: `${prefix} Zulu`,
  });
  await createFixture(page, "expense", {
    name: `Quality evidence ${Date.now()}`,
    productId: product.id,
    cost: 2,
    date: "2026-09-10",
    costType: "materials",
    trade: "other",
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
  const qualityCell = () => page.locator('[data-cell-col="quality"]').first();
  await expect(qualityCell()).toHaveText(/^\d+\/100$/);
  expect((await qualityCell().boundingBox())?.width).toBeLessThanOrEqual(104);
  await page
    .getByRole("button", { name: "Sort by Quality", exact: true })
    .click();
  await expect(zulu).toBeVisible();
  await expect(alpha).toHaveCount(0);
  await expect(page).toHaveURL(/orderBy=quality/);
  await page.getByRole("button", { name: "Sort by Name", exact: true }).click();
  await expect(alpha).toBeVisible();
  await page.getByRole("button", { name: "Go to next page" }).click();
  await expect(zulu).toBeVisible();
  await page.getByRole("button", { name: "Type: any", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter Type" }).fill("Location");
  await page.getByRole("option", { name: "Location", exact: true }).click();
  await page.getByRole("heading", { name: "Entities", exact: true }).click();
  await expect(page).toHaveURL(/kind=location/);
  await expect(alpha).toBeVisible();
  await expect(page).toHaveURL(/page=1/);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Type: Location" }),
  ).toBeVisible();
  await expect(alpha).toBeVisible();

  const editOverflow = async (label: string, value: string) => {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
    await page.getByLabel(`Filter ${label}`, { exact: true }).fill(value);
  };
  await editOverflow("Maximum quality", "0");
  await expect(alpha).toHaveCount(0);
  await page.getByLabel("Filter Maximum quality", { exact: true }).fill("");
  await expect(alpha).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Image: any", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter Image" }).fill("No image");
  await page.getByRole("option", { name: "No image", exact: true }).click();
  await expect(alpha).toBeVisible();
  await page.getByRole("combobox", { name: "Filter Image" }).fill("Has image");
  await page.getByRole("option", { name: "Has image", exact: true }).click();
  await expect(alpha).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await page.keyboard.press("Escape");
  await editOverflow("Updated through", "2000-01-01");
  await expect(alpha).toHaveCount(0);
  await page.getByLabel("Filter Updated through", { exact: true }).fill("");
  await expect(alpha).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Sort by Quality", exact: true })
    .click();
  await expect(page).toHaveURL(/orderBy=quality/);
  await expect(qualityCell()).toHaveText("Not assessed");
  await page.getByRole("button", { name: /^Clear \d+$/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Name or shortcode" }),
  ).toHaveValue("");
  await expect(page.getByRole("button", { name: "Type: any" })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Type: Location" }),
  ).toBeVisible();
  await expect(alpha).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("records-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "Name or shortcode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Filter(?: \d+)?$/ }).click();
  await page.getByRole("button", { name: /Minimum quality/ }).click();
  await expect(
    page.getByLabel("Filter Minimum quality", { exact: true }),
  ).toHaveAttribute("type", "number");
  await expect(
    page.getByLabel("Filter Minimum quality", { exact: true }),
  ).toHaveAttribute("max", "100");
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("records-phone.png") });
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
  ).toHaveText(/^\d+\/100$/);
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
  await expect(
    page.getByRole("button", { name: "Locations view: List", exact: true }),
  ).toBeVisible();
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
  // Early typing must survive cold hydration and toolbar portal placement.
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
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
  // The throttle guards the early typing above; card totals need no typing.
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });

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

test("record dates retain their calendar label with present and future context", async ({
  page,
}) => {
  const prefix = `Date context ${Date.now()}`;
  const today = householdLocalDate();
  const later = householdDaysFromNow(26);
  const project = await createFixture(page, "project", {
    name: `${prefix} project`,
  });
  await createFixture(page, "task", {
    name: `${prefix} ongoing`,
    trade: "other",
    projectId: project.id,
    dueDate: today,
    dueEndDate: householdDaysFromNow(1),
  });
  const currentLabel = `${formatCalendarDay(today, "monthDay")} (today)`;
  const laterYear =
    later.slice(0, 4) === today.slice(0, 4) ? "" : `, ${later.slice(0, 4)}`;
  const futureLabel = `${formatCalendarDay(later, "monthDay")}${laterYear} (in a few weeks)`;
  await createFixture(page, "task", {
    name: `${prefix} current`,
    projectId: project.id,
    trade: "other",
    dueDate: today,
  });
  await createFixture(page, "task", {
    name: `${prefix} future`,
    projectId: project.id,
    trade: "other",
    dueDate: later,
  });
  await gotoAuthenticatedPage(
    page,
    `/tasks?view=next&q=${encodeURIComponent(prefix)}`,
  );
  await expect(
    page.getByRole("row").filter({ hasText: `${prefix} current` }),
  ).toContainText(currentLabel);
  await expect(
    page.getByRole("row").filter({ hasText: `${prefix} future` }),
  ).toContainText(futureLabel);
  await gotoAuthenticatedPage(page, `/tasks?q=${encodeURIComponent(prefix)}`);
  await expect(
    page.locator('[data-cell-col="dueDate"]').filter({ hasText: "(today)" }),
  ).toHaveText(currentLabel);
  await expect(
    page
      .locator('[data-cell-col="dueDate"]')
      .filter({ hasText: "(in a few weeks)" }),
  ).toHaveText(futureLabel);
  const futureTaskLabel = page.getByText(futureLabel, { exact: true });
  const unclipped = async (label: typeof futureTaskLabel) => {
    await expect(label).toBeVisible();
    expect(
      await label.evaluate((element) => {
        for (
          let node = element instanceof HTMLElement ? element : null;
          node;
          node = node.parentElement
        ) {
          const overflow = getComputedStyle(node).overflowX;
          if (
            (overflow === "hidden" || overflow === "clip") &&
            node.scrollWidth > node.clientWidth + 1
          )
            return false;
          if (node.hasAttribute("data-cell-col")) break;
        }
        return true;
      }),
    ).toBe(true);
  };
  await unclipped(futureTaskLabel);
  await createFixture(page, "expense", {
    name: `${prefix} expense`,
    date: later,
    cost: 2,
    costType: "materials",
    trade: "other",
  });
  await gotoAuthenticatedPage(
    page,
    `/expenses?q=${encodeURIComponent(`${prefix} expense`)}`,
  );
  await expect(
    page
      .locator('[data-cell-col="date"]')
      .filter({ hasText: "(in a few weeks)" }),
  ).toHaveText(futureLabel);
  await unclipped(page.getByText(futureLabel, { exact: true }));
  await gotoAuthenticatedPage(page, "/projects?view=overview");
  const ongoing = page.getByRole("link", {
    name: `${prefix} ongoing`,
    exact: true,
  });
  await expect(ongoing).toBeVisible();
  await expect(ongoing.locator("..")).toContainText("(ongoing)");
});
