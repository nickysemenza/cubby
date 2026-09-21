import {
  isSlotListView,
  listViewId,
} from "@cubby/schemas/entity-definitions/definition";
import {
  type BrowserRoutedEntity,
  browserRoutedEntities,
} from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  identityListConfig,
  identityPatch,
} from "~/app/_components/entity-list/identity-list-config";
import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/app/_components/hooks/usePaginatedTableCore";
import { listPage } from "~/app/_components/routing/entity-routes";
import { entities } from "~/entities/entities";
import {
  listEntities,
  mealListItem,
  parseEntityListInput,
  productListItem,
} from "~/entities/generated/entity-lists.gen";
import { listOverrides } from "~/entities/list-columns";
import { mealNameUpdate } from "~/entities/list-columns/meal";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { resolveListView } from "./generic-entity-list";
import { listSlotFor } from "./list-slots";

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
) {
  const Page = listPage({
    entity,
    operations: { list: listOperation(rows) },
  });
  harness = createBrowserTestHarness({
    initialPath: path,
    route: { path: entities[entity].routes.list, component: Page },
  });
  await harness.loadRouter();
  return render(<div />, { wrapper: harness.routerWrapper });
}

const listedEntities = browserRoutedEntities.filter(
  (entity) => entitySummary[entity].list.views.length > 0,
);

describe("resolveListView", () => {
  it.each(listedEntities)(
    "%s: `?view=` selects each declared view and defaults to the first",
    (entity) => {
      const { views } = entitySummary[entity].list;
      for (const declared of views) {
        expect(
          resolveListView(entity, { view: listViewId(declared) }).view,
        ).toEqual(declared);
      }
      expect(resolveListView(entity, {}).view).toEqual(views[0]);
      expect(resolveListView(entity, { view: "no-such-view" }).view).toEqual(
        views[0],
      );
    },
  );

  it("every declared slot view has a web fill, and no fill is undeclared", () => {
    for (const entity of listedEntities) {
      for (const view of entitySummary[entity].list.views) {
        if (!isSlotListView(view)) continue;
        expect(
          listSlotFor(entity, view.id),
          `${entity}.${view.id}`,
        ).toBeDefined();
      }
    }
  });

  it("keeps the old Projects gallery URL pointed at the shared Cards view", () => {
    expect(resolveListView("project", { view: "gallery" }).view).toBe("shelf");
  });

  it("an index route outside the kernel list roster pages its own rows", () => {
    // Neither has a generic list read: cookbook pages one projection in the
    // browser, image reads through its own module `source`.
    const roster: readonly string[] = listEntities;
    for (const entity of ["cookbook", "image"] as const) {
      expect(roster.includes(entity)).toBe(false);
      expect(listOverrides[entity]).toBeDefined();
    }
    expect(listOverrides.cookbook?.mode).toBe("client");
  });
});

describe("listPage", () => {
  it("renders the manifest's header links and universal List/Cards/Compact choices", async () => {
    await renderListPage("recipe", "/recipes", []);
    for (const link of entitySummary.recipe.list.links) {
      expect(screen.getByRole("button", { name: link.label })).toHaveAttribute(
        "href",
        link.path,
      );
    }
    const switcher = screen.getByRole("group", { name: "Recipes view" });
    expect(
      within(switcher)
        .getAllByRole("button")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["List view", "Cards view", "Compact view"]);
  });

  it("offers every declared view and marks the `?view=` one selected", async () => {
    // The built-in timeline view: a slot view would mount its own route API.
    await renderListPage("task", "/tasks?view=timeline", []);
    const switcher = screen.getByRole("group", { name: "Tasks view" });
    const options = within(switcher).getAllByRole("button");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(
      entitySummary.task.list.views.flatMap((view) => {
        const label = isSlotListView(view)
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
      within(switcher).getByRole("button", { name: "Timeline view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("clears table selection and bulk actions after browsing Cards and returning to List", async () => {
    const product = mock(productListItem, {
      overrides: {
        id: testShortcode("product", "PRD-4K7M"),
        name: "Cast iron skillet",
        externalIds: [],
        displayImages: [],
      },
    });
    await renderListPage("product", "/products?view=table", [product]);

    const rowSelection = await screen.findByRole("checkbox", {
      name: "Select row",
    });
    fireEvent.click(rowSelection);
    expect(rowSelection).toBeChecked();
    expect(screen.getByText("1 selected")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cards view" }));
    expect(await screen.findByTestId("entity-card-grid")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
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

  it("maps derived and explicit identity edits to their stored fields", () => {
    expect(identityPatch("name", "New vendor")).toEqual({
      name: "New vendor",
    });
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
      displayName: "Weeknight Supper",
      displayImages: [],
    },
  });

  // Regression: the projects index crashed at column build because a
  // reference column (`parentProjectId`) had no override; every declared
  // table view must build its columns from the manifest alone.
  it.each(
    listedEntities.filter((entity) =>
      entitySummary[entity].list.views.includes("table"),
    ),
  )(
    "table: %s builds its columns and header without an override",
    async (entity) => {
      await renderListPage(
        entity,
        `${entities[entity].routes.list}?view=table`,
        [],
      );
      expect(
        await screen.findByRole("table", { name: /table$/i }),
      ).toBeVisible();
      expect(
        screen.queryByText("Something went wrong"),
      ).not.toBeInTheDocument();
    },
  );

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
        category: "household",
        externalIds: [],
        displayImages: [],
      },
    });
    const unpriced = mock(productListItem, {
      overrides: {
        id: testShortcode("product", "PRD-ZX4C"),
        name: "Mystery gadget",
        price: null,
        category: "tools",
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
    expect(within(gadgetCard!).getByText(/tools/iu)).toBeVisible();
  });
});
