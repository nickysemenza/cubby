import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { formatCategoryLabel } from "@cubby/shared";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { categorySummaryFixture } from "tooling/product-category-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entities } from "~/entity/entities";
import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import { identityListConfig } from "~/entity/entity-list/identity-list-config";
import {
  ledgerPartyListItem,
  getEntityListOutputSchema,
  mealListItem,
  parseEntityListInput,
  productListItem,
} from "~/entity/generated/entity-lists.gen";
import { listOverrides } from "~/entity/list-columns/list-overrides.fixtures";
import {
  listReadFields,
  projectListRows,
} from "~/entity/model/list-read-schema";
import { listPage } from "~/entity/routing/list-page";
import { mealNameUpdate } from "~/features/meal/list-columns";
import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";

installFeatures();

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;

beforeEach(() => {
  // jsdom has no observer for the shelf's infinite-scroll sentinel.
  class TestIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  vi.unstubAllGlobals();
});

/** The table's filter and pagination state stays real; only the read is canned. */
function listOperation<TRow extends { id: string }>(
  rows: TRow[],
): ListQueryOptionsFn<object, TRow> {
  const response: ListQueryResponse<TRow> = {
    items: rows,
    meta: { pageIndex: 0, pageSize: 100, totalCount: rows.length },
  };
  return (params) => ({
    queryKey: ["browser-test", "generic-list", params],
    execute: async () => response,
  });
}

async function renderListPage(
  entity: BrowserRoutedEntity,
  path: string,
  rows: { id: string }[],
  operation?: ListQueryOptionsFn<object, { id: string }>,
) {
  const Page = listPage({
    entity,
    override: listOverrides[entity],
    operations: { list: operation ?? listOperation(rows) },
  });
  harness = createBrowserTestHarness({
    initialPath: path,
    route: { path: entities[entity].routes.list, component: Page },
  });
  await harness.loadRouter();
  return render(<div />, { wrapper: harness.routerWrapper });
}

describe("list manifest and deferred rows", () => {
  // Provider hydration, subject menus, unit mapping and tree nesting execute
  // before deferred cells. Each must tolerate a core-only page.
  it.each(["inventory", "ingredient", "wish", "product"] as const)(
    "renders %s core rows while relation enrichment is pending",
    async (entity) => {
      const fields = listReadFields(entity);
      const full = mock(getEntityListOutputSchema(entity));
      const rows = projectListRows(entity, full.items, { kind: "base" });
      const operation: ListQueryOptionsFn<object, { id: string }> = (
        params,
      ) => ({
        queryKey: ["deferred-provider", entity, params],
        execute: async () => ({
          items: rows,
          meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
          deferredGroups: (
            ["media", "quality", "relations", "derived"] as const
          ).map((id) => ({ id, fields: fields[id] })),
        }),
        progressive: {
          enrich: async () => new Promise(() => {}),
          summary: async () => ({}),
        },
      });
      await renderListPage(
        entity,
        `${entities[entity].routes.list}?view=table`,
        rows,
        operation,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("checkbox", { name: "Select row" }),
        ).toBeInTheDocument(),
      );
    },
  );
});

describe("listPage", () => {
  it("renders the manifest's header links, universal List/Cards/Compact choices, and Group by", async () => {
    await renderListPage("recipe", "/recipes", []);
    for (const link of entitySummary.recipe.list.links) {
      expect(screen.getByRole("button", { name: link.label })).toHaveAttribute(
        "href",
        link.path,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: /Recipes view:/ }));
    const switcher = await screen.findByRole("menu");
    expect(
      within(switcher)
        .getAllByRole("menuitem")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["List view", "Cards view", "Compact view"]);
    fireEvent.keyDown(switcher, { key: "Escape" });
    // Group by is its own menu beside the view menu.
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    const grouping = await screen.findByRole("menu");
    expect(
      within(grouping)
        .getAllByRole("menuitem")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(
      expect.arrayContaining([
        "Group by None",
        "Group by Cookbook",
        "Group by Tags",
      ]),
    );
    const tags = within(grouping).getByRole("menuitem", {
      name: "Group by Tags",
    });
    expect(tags).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(tags);
    expect(
      await screen.findByRole("button", { name: /Grouped by Tags/ }),
    ).toBeVisible();
  });

  it("offers every declared view and marks the `?view=` one selected", async () => {
    // The built-in timeline view: a slot view would mount its own route API.
    await renderListPage("task", "/tasks?view=timeline", []);
    fireEvent.click(screen.getByRole("button", { name: /Tasks view:/ }));
    const switcher = await screen.findByRole("menu");
    const options = within(switcher).getAllByRole("menuitem");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(
      entitySummary.task.list.views.flatMap((view) => {
        const label =
          typeof view === "object"
            ? view.label
            : view === "table"
              ? "List"
              : view === "shelf"
                ? "Cards"
                : "Timeline";
        return view === "shelf"
          ? [`${label} view`, "Compact view"]
          : [`${label} view`];
      }),
    );
    expect(
      within(switcher).getByRole("menuitem", { name: "Timeline view" }),
    ).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(switcher, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    const status = within(await screen.findByRole("menu")).getByRole(
      "menuitem",
      { name: "Group by Status" },
    );
    expect(status).toHaveAttribute("aria-disabled", "true");
    expect(status).toHaveTextContent("This view is already arranged by date.");
  });

  it("clears table selection and bulk actions after browsing Cards and returning to List", async () => {
    // A plain roster isolates shared selection from Product's kit/media reads.
    const party = mock(ledgerPartyListItem, {
      overrides: {
        id: testShortcode("ledgerParty", "LPY-4K7M"),
        name: "Example party",
        displayImages: [],
      },
    });
    await renderListPage("ledgerParty", "/ledger-parties?view=table", [party]);

    const rowSelection = await screen.findByRole("checkbox", {
      name: "Select row",
    });
    fireEvent.click(rowSelection);
    expect(rowSelection).toBeChecked();
    expect(screen.getByText("1 selected")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: /Ledger parties view:/i }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Cards view" }),
    );
    expect(await screen.findByTestId("entity-card-grid")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: /Ledger parties view:/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "List view" }));
    const restoredRowSelection = await screen.findByRole("checkbox", {
      name: "Select row",
    });
    await waitFor(() => expect(restoredRowSelection).not.toBeChecked());
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).toBeNull();
  });
});

describe("GenericEntityList", () => {
  it("keeps the primary search in a generic list request", () => {
    // Cards and Compact use the same transport parser as List. If this is
    // absent, Zod strips the typed search before the server can filter it.
    expect(
      parseEntityListInput("product", {
        entity: "product",
        filters: { searchQuery: "precision workshop tool" },
      }).filters,
    ).toMatchObject({ searchQuery: "precision workshop tool" });
  });

  it.each([
    {
      label: "Vendor name",
      entity: "vendor" as const,
      generatedCrud: true,
      flatRows: true,
      titleField: "name",
      canAutoEdit: true,
    },
    {
      label: "Meal display name",
      entity: "meal" as const,
      generatedCrud: true,
      flatRows: true,
      titleField: "displayName",
      canAutoEdit: false,
    },
    {
      label: "tree rows",
      entity: "vendor" as const,
      generatedCrud: true,
      flatRows: false,
      titleField: "name",
      canAutoEdit: false,
    },
    {
      label: "custom source rows",
      entity: "vendor" as const,
      generatedCrud: true,
      flatRows: false,
      titleField: "name",
      canAutoEdit: false,
    },
  ])(
    "$label: derives identity editing only for a flat readable/updateable title field",
    ({ entity, generatedCrud, flatRows, titleField, canAutoEdit }) => {
      const config = identityListConfig(entity, { generatedCrud, flatRows });
      expect(config.titleField).toBe(titleField);
      expect(config.canAutoEdit).toBe(canAutoEdit);
    },
  );

  it("maps an explicit identity edit to its stored field", () => {
    expect(mealNameUpdate("  ")).toEqual({ name: null });
  });

  const meal = mock(mealListItem, {
    overrides: {
      id: testShortcode("meal", "ML-4K7M"),
      date: "2026-08-18",
      name: "Weeknight Supper",
      mealType: "dinner",
      mealKind: "cooked",
      recipes: [],
      totals: withMacros({
        cost: {
          status: "complete",
          lower: 18.5,
          upper: null,
          coverage: { covered: 1, total: 1 },
        },
        nutrition: buildNutrition(() => ({
          status: "unavailable",
          reason: "no_data",
        })),
      }),
      costTotalLabel: "$18.50",
      displayName: "Weeknight Supper",
      displayImages: [],
    },
  });

  // Project reference columns once crashed before the first row rendered.
  // Populated shared rendering belongs to list-capabilities.preview.test.tsx.
  it("builds Project reference columns without an override", async () => {
    await renderListPage("project", "/projects?view=table", []);
    expect(await screen.findByRole("table", { name: /table$/i })).toBeVisible();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("table: renders server-backed rows through the entity's column module", async () => {
    await renderListPage("meal", "/meals?view=table", [meal]);
    expect(
      await screen.findByRole("link", { name: "Weeknight Supper" }),
    ).toHaveAttribute("href", `/meals/${meal.id}`);
    expect(screen.getByRole("table", { name: "Meals table" })).toBeVisible();
    expect(screen.getByText("Dinner")).toBeVisible();
    expect(screen.getByText("Cooked")).toBeVisible();
    expect(screen.getByText("$18.50")).toBeVisible();
  });

  it("shelf: captions each card from the declared `shelf.subtitle` fields", async () => {
    const priced = mock(productListItem, {
      overrides: {
        id: testShortcode("product", "PRD-4K7M"),
        name: "Cast iron skillet",
        price: 42,
        categoryId: categorySummaryFixture("household").id,
        category: categorySummaryFixture("household"),
        externalIds: [],
        displayImages: [],
      },
    });
    const unpriced = mock(productListItem, {
      overrides: {
        id: testShortcode("product", "PRD-ZX4C"),
        name: "Mystery gadget",
        price: null,
        categoryId: categorySummaryFixture("tools").id,
        category: categorySummaryFixture("tools"),
        externalIds: [],
        displayImages: [],
      },
    });
    await renderListPage("product", "/products?view=shelf", [priced, unpriced]);
    const skillet = await screen.findByRole("link", {
      name: "Cast iron skillet",
    });
    expect(skillet).toHaveAttribute("href", `/products/${priced.id}`);
    const skilletCard = skillet.closest<HTMLElement>("[data-entity-card]");
    expect(skilletCard).not.toBeNull();
    expect(within(skilletCard!).getByText("$42.00")).toBeVisible();
    // The second subtitle field is the caption when the first is empty.
    const gadget = screen.getByRole("link", {
      name: "Mystery gadget",
    });
    const gadgetCard = gadget.closest<HTMLElement>("[data-entity-card]");
    expect(gadgetCard).not.toBeNull();
    expect(
      within(gadgetCard!).getByText(formatCategoryLabel(unpriced.category)),
    ).toBeVisible();
    expect(gadgetCard).not.toHaveTextContent('"path"');
    expect(gadgetCard?.querySelector("pre")).toBeNull();
  });
});

it("embeds a fixed saved view without inheriting its host URL and links the whole matching population", async () => {
  const reads: unknown[] = [];
  const operation: ListQueryOptionsFn<object, { id: string }> = (params) => ({
    queryKey: ["synthetic-embed", params],
    execute: async () => {
      reads.push(params);
      return {
        items: [],
        meta: { pageIndex: 0, pageSize: 10, totalCount: 37 },
      };
    },
  });
  harness = createBrowserTestHarness({
    initialPath: "/?kind=foreign&sort=-date",
  });
  render(
    <EmbeddedEntityList
      entity="run"
      savedViewId="attention"
      filters={{ purpose: ["maintenance"] }}
      pageSize={10}
      allLink
      operations={{ list: operation }}
    />,
    { wrapper: harness.wrapper },
  );
  const link = await screen.findByRole("link", { name: "All 37" });
  expect(link.getAttribute("href")).toContain("/runs");
  expect(link.getAttribute("href")).toContain("needsAttention");
  expect(link.getAttribute("href")).not.toContain("foreign");
  expect(reads).toContainEqual(
    expect.objectContaining({
      filters: expect.objectContaining({
        purpose: ["maintenance"],
        needsAttention: true,
      }),
      pagination: { pageIndex: 0, pageSize: 10 },
      sort: [
        { orderBy: "stalled", direction: "desc" },
        { orderBy: "startedAt", direction: "desc" },
      ],
    }),
  );
});
