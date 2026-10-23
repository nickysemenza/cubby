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

import {
  productListItem,
  taskListItem,
} from "~/entity/generated/entity-lists.gen";
import { listOverrides } from "~/entity/list-columns/list-overrides.fixtures";
import { listPage } from "~/entity/routing/list-page";
import { installFeatures } from "~/features/registry";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";

installFeatures();
let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const productName = "Example precision workshop tool";
const product = mock(productListItem, {
  overrides: {
    id: testShortcode("product", "PRD-4K7M"),
    name: productName,
    displayImages: [],
    externalIds: [],
    price: 12,
    pricing: {
      effectivePrice: 12,
      source: "explicit",
      knownExpenseCount: 0,
      partial: false,
    },
    expenseCount: 1,
    purchaseDate: "2025-09-03",
    primaryGtin: "012345678905",
  },
});

async function mount(path: string, empty = false) {
  let rows = empty ? [] : [product];
  const requests: object[] = [];
  const operation: ListQueryOptionsFn<object, typeof product> = (params) => ({
    queryKey: ["list-capability", params],
    execute: async () => {
      requests.push(params);
      return {
        items: rows,
        meta: { pageIndex: 0, pageSize: 100, totalCount: rows.length },
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
  },
);

it("changes card density without storing it in navigation and resets on remount", async () => {
  await page.viewport(1600, 1000);
  await mount("/products?view=shelf");
  const grid = await screen.findByTestId("entity-card-grid");
  const card = await screen.findByRole("link", { name: productName });
  const standardWidth = card.getBoundingClientRect().width;
  fireEvent.click(screen.getByRole("button", { name: /Products view:/i }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Compact view" }),
  );
  await waitFor(() => expect(grid).toHaveAttribute("data-compact", "true"));
  expect(card.getBoundingClientRect().width).toBeLessThan(standardWidth * 0.7);
  expect(harness?.router.state.location.search).not.toHaveProperty("density");
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
  expect(grid).toHaveAttribute("data-compact", "true");
  expect(search).toHaveFocus();
  harness?.dispose();
  harness = undefined;
  await mount("/products?view=shelf");
  expect(await screen.findByTestId("entity-card-grid")).toHaveAttribute(
    "data-compact",
    "false",
  );
});

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
    expect(width("price")).toBeLessThanOrEqual(80);
    expect(width("purchaseDate")).toBeLessThanOrEqual(88);
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
  expect(row?.querySelector('[data-cell-col="price"]')).toHaveTextContent(
    "$12.00",
  );
  expect(row?.querySelector('[data-cell-col="primaryGtin"]')).toHaveTextContent(
    "0123",
  );
  expect(row?.querySelector('[data-cell-col="primaryGtin"]')).toHaveTextContent(
    "8905",
  );
});

// SQL quality ordering has its real PostgreSQL owner; the shared control must
// still emit the declared sort instead of sorting only the current page.
it("keeps quality beside identity and emits its server sort", async () => {
  await page.viewport(1440, 900);
  const state = await mount("/products?view=table");
  await screen.findByRole("link", { name: productName });
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
});

// The SQL identity and bulk-write owners retain filtering and persistence.
// This native owner must admit an unloaded row without fetching every list page.
it("bulk-edits all matching identities including an unloaded record", async () => {
  await page.viewport(1440, 900);
  const first = mock(taskListItem, {
    overrides: {
      id: testShortcode("task", "TSK-4K7M"),
      name: "Example first task",
      status: "in_progress",
      trade: "other",
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
          meta: { pageIndex: 0, pageSize: 100, totalCount: 3 },
        };
      if (params.pagination.pageIndex > 0) await nextPage;
      return {
        items: params.pagination.pageIndex > 0 ? [unloaded] : [first, second],
        meta: {
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
    restore = overrideStartDispatch(async (operation, input) => {
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
