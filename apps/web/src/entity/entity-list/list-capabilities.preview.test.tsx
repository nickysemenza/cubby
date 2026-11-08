import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { listOverrides } from "~/entity/list-columns/list-overrides.fixtures";
import { listPage } from "~/entity/routing/list-page";
import { installFeatures } from "~/features/registry";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { mock } from "~/lib/test/mock-schema";
import { getEntityListItemSchema } from "~/server/entity-reads/list-contracts";
const productListItem = getEntityListItemSchema("product");
const taskListItem = getEntityListItemSchema("task");

import type { ListQueryOptionsFn } from "~/entity/table/use-paginated-table-core";

installFeatures();
let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const productName = "Example precision workshop tool";
const product = mock(productListItem, {
  overrides: {
    fields: {
      displayImages: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
          "displayImages"
        ],
        [],
      ),
      cost: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape.cost,
        { kind: "item", amount: 12 },
      ),
      price: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape["price"],
        12,
      ),
      expenseCount: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
          "expenseCount"
        ],
        2,
      ),
      expenseTotal: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape.expenseTotal,
        10,
      ),
      purchaseDate: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
          "purchaseDate"
        ],
        "2025-09-03",
      ),
      primaryGtin: fieldValueFixture(
        entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
          "primaryGtin"
        ],
        "012345678905",
      ),
    },
    id: testShortcode("product", "PRD-4K7M"),
    name: productName,

    externalIds: [],
  },
});

async function mount(path: string, empty = false, contactSheet = false) {
  const metrics = {
    expenseTotal: { sum: 10, presentCount: 2, totalCount: 2, coverage: 1 },
    sellerSpending: { sum: 12, presentCount: 1, totalCount: 1, coverage: 1 },
    unattributedSpending: {
      sum: -2,
      presentCount: 1,
      totalCount: 1,
      coverage: 1,
    },
    plannedExpenses: { sum: 0, presentCount: 0, totalCount: 0, coverage: null },
    reimbursementExpenses: {
      sum: 0,
      presentCount: 0,
      totalCount: 0,
      coverage: null,
    },
  };
  const sellerCode = testShortcode("vendor", "VEN-4K7M");
  const groupMetrics = {
    ...metrics,
    unattributedSpending: {
      sum: 0,
      presentCount: 0,
      totalCount: 0,
      coverage: null,
    },
  };
  const picturedProduct = {
    ...product,
    id: testShortcode("product", "PRD-8P2N"),
    name: "Example blue storage box",
    displayCover: {
      image: {
        id: testShortcode("image", "IMG-4K7M"),
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='40'%3E%3Crect width='80' height='40' fill='%230077e6'/%3E%3C/svg%3E",
      },
      count: 1,
    },
  };
  let rows = empty ? [] : contactSheet ? [product, picturedProduct] : [product];
  const requests: object[] = [];
  const operation: ListQueryOptionsFn<object, typeof product> = (params) => ({
    queryKey: ["list-capability", params],
    execute: async () => {
      requests.push(params);
      return {
        items: rows,
        meta: {
          hasNextPage: false,
          pageIndex: 0,
          pageSize: 100,
          totalCount: rows.length,
          metrics,
          ...(params.groupBy?.length === 2
            ? {
                groups: [
                  {
                    key: JSON.stringify(["2025-09-01"]),
                    path: ["2025-09-01"],
                    label: "September 2025",
                    count: 1,
                    parentCount: 1,
                    fraction: 1,
                    overlapping: false,
                    metrics,
                  },
                  {
                    key: JSON.stringify(["2025-09-01", sellerCode]),
                    path: ["2025-09-01", sellerCode],
                    label: "Sample Seller",
                    count: 1,
                    parentCount: 1,
                    fraction: 1,
                    overlapping: false,
                    metrics: groupMetrics,
                  },
                ],
                margins: [
                  {
                    dimensions: [1],
                    path: [sellerCode],
                    count: 1,
                    metrics: groupMetrics,
                  },
                ],
                memberships: [
                  { id: product.id, path: ["2025-09-01", sellerCode] },
                ],
                membershipCount: 1,
              }
            : {}),
        },
      };
    },
  });
  const Page = listPage({
    entity: "product",
    override: listOverrides.product,
    operations: { list: operation },
  });
  harness = createBrowserTestHarness({
    initialPath: path,
    route: { path: "/products", component: Page },
  });
  await harness.loadRouter();
  render(<div />, { wrapper: harness.routerWrapper });
  return {
    requests,
    showProduct: () => {
      rows = [product];
    },
  };
}

// Server filtering remains in the HTTP/PostgreSQL owners. These states exercise
// the actual list renderer and outbound request, without a second filter engine.
it.each([1440, 402])(
  "clears a filtered-empty list into native cards or phone rows at %ipx",
  async (width) => {
    await page.viewport(width, 874);
    const state = await mount(
      `/products?name=missing${width === 1440 ? "&view=shelf" : ""}`,
      true,
    );
    const clear = await screen.findByRole("button", { name: "Clear filters" });
    expect(state.requests).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ nameFilter: "missing" }),
      }),
    );
    state.showProduct();
    fireEvent.click(clear);
    const surface =
      width === 1440
        ? await screen.findByTestId("entity-card-grid")
        : (await screen.findAllByRole("listitem")).find((item) =>
            item.textContent?.includes(productName),
          );
    if (!surface)
      throw new Error("Recovered Product has no responsive list surface");
    expect(
      within(surface).getByRole("link", { name: productName }),
    ).toBeVisible();
    await waitFor(() =>
      expect(state.requests.at(-1)).not.toEqual(
        expect.objectContaining({
          filters: expect.objectContaining({ nameFilter: "missing" }),
        }),
      ),
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const footer = document.querySelector("[data-list-footer]");
    if (!(footer instanceof HTMLElement))
      throw new Error("No list totals footer");
    expect(within(footer).getByText("Seller spending")).toBeVisible();
    expect(within(footer).getByText("Unattributed spending")).toBeVisible();
    fireEvent.click(
      within(footer).getByRole("button", { name: "Explain these totals" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Contribution details")).toBeVisible(),
    );
    expect(screen.getByText("Planned expenses")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    if (width !== 402) return;
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filters = await screen.findByRole("dialog", { name: "Filter" });
    const brand = within(filters).getByRole("button", { name: "Brand" });
    expect(brand).toHaveTextContent("record");
    fireEvent.click(brand);
    const editor = await screen.findByRole("dialog", {
      name: "Filter by Brand",
    });
    await waitFor(() =>
      expect(within(editor).getByText(/Is \/ is not/)).toBeVisible(),
    );
    fireEvent.click(within(editor).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const reopened = await screen.findByRole("dialog", { name: "Filter" });
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Sort by Updated at" }),
    );
    await waitFor(() =>
      expect(state.requests.at(-1)).toEqual(
        expect.objectContaining({
          sort: expect.arrayContaining([
            expect.objectContaining({ orderBy: "updatedAt" }),
          ]),
        }),
      ),
    );
    fireEvent.click(within(reopened).getByRole("button", { name: "Columns" }));
    const columns = await screen.findByRole("dialog", { name: "Columns" });
    fireEvent.click(
      within(columns).getByRole("checkbox", { name: "Hide Cost" }),
    );
    expect(
      await within(columns).findByRole("checkbox", { name: "Show Cost" }),
    ).not.toBeChecked();
    fireEvent.click(
      within(columns).getByRole("checkbox", { name: "Show Cost" }),
    );
    expect(
      await within(columns).findByRole("checkbox", { name: "Hide Cost" }),
    ).toBeChecked();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

it.each([1440, 402])(
  "changes temporary card and contact sheet layouts at %ipx",
  async (width) => {
    await page.viewport(width, 1000);
    await mount("/products?view=shelf", false, true);
    const grid = await screen.findByTestId("entity-card-grid");
    const card = await screen.findByRole("link", { name: productName });
    const standardWidth = card.getBoundingClientRect().width;
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Products view:/i }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Compact view" }),
    );
    await waitFor(() => expect(grid).toHaveAttribute("data-compact", "true"));
    expect(card.getBoundingClientRect().width).toBeLessThan(
      standardWidth * 0.7,
    );
    expect(harness?.router.state.location.search).not.toHaveProperty("density");
    fireEvent.click(screen.getByRole("button", { name: /Products view:/i }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Contact sheet view" }),
    );
    await userEvent.keyboard("{Escape}");
    const sheet = await screen.findByTestId("entity-contact-sheet");
    const tile = within(sheet).getByRole("link", {
      name: "Example blue storage box",
    });
    expect(within(sheet).queryByRole("link", { name: productName })).toBeNull();
    expect(screen.getByText("1 loaded record without images")).toBeVisible();
    expect(tile.getBoundingClientRect().width).toBe(32);
    expect(tile.getBoundingClientRect().height).toBe(32);
    expect(getComputedStyle(sheet).gap).toBe("1px");
    const image = tile.querySelector("img");
    if (!image) throw new Error("Contact sheet has no main image");
    expect(getComputedStyle(image).objectFit).toBe("contain");
    fireEvent.click(screen.getByRole("button", { name: "Fill" }));
    expect(getComputedStyle(image).objectFit).toBe("cover");
    screen.getByRole("button", { name: "Fill" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(tile).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Example blue storage box",
    );
    expect(harness?.router.state.location.search).not.toHaveProperty(
      "view",
      "contact-sheet",
    );
    const search = screen.getByRole("textbox", {
      name: "Search products or shortcode",
    });
    search.focus();
    fireEvent.change(search, { target: { value: "precision workshop tool" } });
    await waitFor(() =>
      expect(harness?.router.state.location.search).toHaveProperty(
        "searchQuery",
        "precision workshop tool",
      ),
    );
    expect(sheet).toBeVisible();
    expect(search).toHaveFocus();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    harness?.dispose();
    harness = undefined;
    await mount("/products?view=shelf", false, true);
    expect(await screen.findByTestId("entity-card-grid")).toHaveAttribute(
      "data-compact",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("button", { name: /Products view:/i }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Contact sheet view" }),
    );
    await userEvent.keyboard("{Escape}");
    const resetSheet = await screen.findByTestId("entity-contact-sheet");
    const resetTile = within(resetSheet).getByRole("link", {
      name: "Example blue storage box",
    });
    expect(getComputedStyle(resetTile.querySelector("img")!).objectFit).toBe(
      "contain",
    );
    if (width !== 1440) return;
    resetTile.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(resetTile).toHaveAttribute("aria-current", "true"),
    );
    expect(
      (await screen.findAllByRole("button", { name: "Close inspector" }))
        .length,
    ).toBeGreaterThan(0);
  },
);

// Actual declared Product columns sit inside the shared sizing/rail machinery;
// primitive spill, hover and two-line date cases live in table-density previews.
it("fits populated declared money, count, date and identifier columns", async () => {
  await page.viewport(1440, 900);
  await mount("/products?view=table");
  const link = await screen.findByRole("link", { name: productName });
  // Product declares `images`; generic composition must not prepend `image` too.
  expect(
    document.querySelectorAll(
      'thead th[data-column-id="image"], thead th[data-column-id="images"]',
    ),
  ).toHaveLength(1);
  const row = link.closest("tr");
  expect(row).not.toBeNull();
  const width = (id: string) => {
    const header = document.querySelector(`thead th[data-column-id="${id}"]`);
    expect(header).not.toBeNull();
    return header?.getBoundingClientRect().width ?? Infinity;
  };
  await waitFor(() => {
    expect(width("expenseCount")).toBeLessThanOrEqual(40);
    expect(width("cost")).toBeLessThanOrEqual(80);
    // One line at 24px rows: "Sep 3 · ’25 · 1y ago".
    expect(width("purchaseDate")).toBeLessThanOrEqual(120);
    expect(width("primaryGtin")).toBeLessThanOrEqual(88);
  });
  const dateLines = row?.querySelectorAll(
    '[data-cell-col="purchaseDate"] [data-stacked-line]',
  );
  expect(dateLines).toHaveLength(2);
  expect(dateLines?.[0]).toBeVisible();
  expect(dateLines?.[0]).toHaveTextContent("Sep 3");
  expect(dateLines?.[1]).toBeVisible();
  expect(dateLines?.[1]?.textContent).toMatch(/^’25 · \d+y ago$/);
  expect(row?.querySelector('[data-cell-col="cost"]')).toHaveTextContent(
    "$12.00",
  );
  expect(row?.querySelector('[data-cell-col="primaryGtin"]')).toHaveTextContent(
    "0123",
  );
  expect(row?.querySelector('[data-cell-col="primaryGtin"]')).toHaveTextContent(
    "8905",
  );
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  fireEvent.click(await screen.findByRole("button", { name: "Columns…" }));
  const columns = await screen.findByRole("dialog", { name: "Columns" });
  fireEvent.click(within(columns).getByRole("checkbox", { name: "Hide Cost" }));
  await waitFor(() =>
    expect(row?.querySelector('[data-cell-col="cost"]')).toBeNull(),
  );
  expect(
    within(columns).getByRole("checkbox", { name: "Show Cost" }),
  ).not.toBeChecked();
  fireEvent.click(within(columns).getByRole("checkbox", { name: "Show Cost" }));
  await waitFor(() =>
    expect(row?.querySelector('[data-cell-col="cost"]')).toHaveTextContent(
      "$12.00",
    ),
  );
  const vendors = within(columns).getByRole("checkbox", {
    name: "Show Vendors",
  });
  fireEvent.click(vendors);
  await waitFor(() =>
    expect(
      document.querySelector(
        'thead th[data-column-id="related:product.vendors"] [data-header-entity] svg',
      ),
    ).not.toBeNull(),
  );
  fireEvent.click(
    within(columns).getByRole("button", { name: "Restore default layout" }),
  );
  await waitFor(() =>
    expect(
      within(columns).getByRole("checkbox", { name: "Show Vendors" }),
    ).not.toBeChecked(),
  );
});

// SQL quality ordering has its real PostgreSQL owner; the shared control must
// still emit the declared sort instead of sorting only the current page.
it("keeps quality beside identity and emits its server sort", async () => {
  await page.viewport(1440, 900);
  const state = await mount("/products?view=table");
  await screen.findByRole("link", { name: productName });
  // The fixture has no scores, so Quality starts among the "+N empty" columns.
  fireEvent.click(
    await screen.findByRole("button", { name: /empty columns hidden/ }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Quality" }));
  await screen.findByRole("button", { name: "Sort by Quality" });
  const ids = Array.from(
    document.querySelectorAll("thead th[data-column-id]"),
    (header) => header.getAttribute("data-column-id"),
  );
  expect(ids.indexOf("dataQuality")).toBe(ids.indexOf("name") + 1);
  fireEvent.click(screen.getByRole("button", { name: "Sort by Quality" }));
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual(
      expect.objectContaining({
        sort: expect.arrayContaining([
          expect.objectContaining({ orderBy: "dataQuality" }),
        ]),
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Sort:/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Updated at" }));
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual(
      expect.objectContaining({
        sort: expect.arrayContaining([
          expect.objectContaining({ orderBy: "updatedAt" }),
        ]),
      }),
    ),
  );
  expect(
    document.querySelector('thead th[data-column-id="updatedAt"]'),
  ).toBeNull();
  if (!screen.queryByRole("button", { name: "Group by" }))
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  fireEvent.click(await screen.findByRole("button", { name: "Group by" }));
  expect(
    screen.queryByRole("menuitem", { name: "Group by Deleted at" }),
  ).toBeNull();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Group by Purchase date" }),
  );
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual(
      expect.objectContaining({
        groupBy: [{ key: "purchaseDate", bucket: "month" }],
      }),
    ),
  );
  if (!screen.queryByRole("button", { name: /^Grouped by/ }))
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Grouped by/ }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Group by Sellers" }),
  );
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual(
      expect.objectContaining({
        groupBy: [{ key: "purchaseDate", bucket: "month" }, { key: "sellers" }],
      }),
    ),
  );
  if (!screen.queryByRole("button", { name: /Products view:/i }))
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Products view:/i }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pivot view" }));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(
    await screen.findByRole("combobox", { name: "Measure" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Seller spending" }),
  );
  const pivot = await screen.findByRole("table", {
    name: /Purchase date by Sellers/,
  });
  expect(
    within(pivot).getByRole("button", { name: /Seller spending: \$12.00/ }),
  ).toBeVisible();
  expect(within(pivot).getAllByText("$12.00").length).toBeGreaterThan(1);
  await userEvent.click(
    within(pivot).getByRole("button", { name: /Seller spending: \$12.00/ }),
  );
  await waitFor(() =>
    expect(state.requests.at(-1)).toEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          purchaseDateFrom: "2025-09-01",
          purchaseDateTo: "2025-09-30",
          sellerId: [testShortcode("vendor", "VEN-4K7M")],
        }),
      }),
    ),
  );
  await page.viewport(402, 900);
  await screen.findByRole("link", { name: productName });
  await waitFor(() => {
    const sellerHeader = Array.from(
      document.querySelectorAll("[data-slot=list-section-header]"),
    ).find((header) => header.textContent?.includes("Sample Seller"));
    if (!(sellerHeader instanceof HTMLElement))
      throw new Error("Phone has no Seller section");
    expect(within(sellerHeader).getByText("Seller spending")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(402);
  });
});

// The SQL identity and bulk-write owners retain filtering and persistence.
// This native owner must admit an unloaded row without fetching every list page.
it("bulk-edits all matching identities including an unloaded record", async () => {
  await page.viewport(1440, 900);
  const first = mock(taskListItem, {
    overrides: {
      fields: {
        trade: fieldValueFixture(
          entityFieldEnvelopeSchemas.task.list.shape.fields.shape["trade"],
          "other",
        ),
      },
      id: testShortcode("task", "TSK-4K7M"),
      name: "Example first task",
      status: "in_progress",
    },
  });
  const second = {
    ...first,
    id: testShortcode("task", "TSK-4K7N"),
    name: "Example second task",
  };
  const unloaded = {
    ...first,
    id: testShortcode("task", "TSK-4K7P"),
    name: "Example unloaded task",
  };
  const selected = [first, second, unloaded];
  const ids = selected.map(({ id }) => id);
  const selections: unknown[] = [];
  const mutations: unknown[] = [];
  const reads: object[] = [];
  let releaseNextPage = () => {};
  const nextPage = new Promise<void>((resolve) => {
    releaseNextPage = resolve;
  });
  let restore = () => {};
  const operation: ListQueryOptionsFn<object, typeof first> = (params) => ({
    queryKey: ["all-matching-capability", params],
    execute: async () => {
      reads.push(params);
      if ("ids" in params.filters)
        return {
          items: [...selected].reverse(),
          meta: {
            hasNextPage: false,
            pageIndex: 0,
            pageSize: 100,
            totalCount: 3,
          },
        };
      if (params.pagination.pageIndex > 0) await nextPage;
      return {
        items: params.pagination.pageIndex > 0 ? [unloaded] : [first, second],
        meta: {
          hasNextPage: params.pagination.pageIndex === 0,
          pageIndex: params.pagination.pageIndex,
          pageSize: 2,
          totalCount: 3,
        },
      };
    },
  });
  const Page = listPage({
    entity: "task",
    override: listOverrides.task,
    operations: { list: operation },
  });
  try {
    harness = createBrowserTestHarness({
      initialPath: "/tasks?name=Example",
      route: { path: "/tasks", component: Page },
    });
    restore = overrideOperationDispatch(async (operation, input) => {
      if (operation === "entity.selectionIds") {
        selections.push(input);
        return { ok: true, data: { ids, totalCount: 3, nextCursor: null } };
      }
      if (operation === "entity.mutate") {
        mutations.push(input);
        return {
          ok: true,
          data: {
            action: "bulkUpdate",
            entity: "task",
            updatedReferences: ids.map((id) => ({ entity: "task", id })),
            sideEffects: {},
          },
        };
      }
      throw new Error(`Unexpected selection operation ${operation}`);
    });
    await harness.loadRouter();
    render(<div />, { wrapper: harness.routerWrapper });
    await screen.findByRole("link", { name: first.name });
    expect(screen.queryByRole("link", { name: unloaded.name })).toBeNull();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Select all 3" }),
    );
    await waitFor(() =>
      expect(selections).toEqual([
        expect.objectContaining({
          entity: "task",
          filters: expect.objectContaining({ search: "Example" }),
        }),
      ]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Bulk edit..." }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.queryByRole("link", { name: unloaded.name })).toBeNull();
    expect(reads).toContainEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ search: "Example", ids }),
      }),
    );
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: "Status" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Done" }));
    const update = within(dialog).getByRole("button", { name: "Update" });
    await waitFor(() => expect(update).toBeEnabled());
    await userEvent.click(update);
    await waitFor(() =>
      expect(mutations).toEqual([
        {
          action: "bulkUpdate",
          entity: "task",
          ids,
          data: { status: "done" },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    releaseNextPage();
    restore();
  }
});
