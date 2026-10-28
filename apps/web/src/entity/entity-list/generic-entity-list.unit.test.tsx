import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
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
import { categoryReadFixture } from "tooling/product-category-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEditorBrowserTestHarness as createBrowserTestHarness,
  createEditorTestQueryClient,
} from "#web/tests/editor-metadata.fixtures.ts";
import { entities } from "~/entity/entities";
import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import { identityListConfig } from "~/entity/entity-list/identity-list-config";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { parseEntityListInput } from "~/entity/generated/entity-lists.gen";
import { listOverrides } from "~/entity/list-columns/list-overrides.fixtures";
import { categoryText } from "~/entity/presentation/category-text";
import { listPage } from "~/entity/routing/list-page";
import { mealNameUpdate } from "~/features/meal/list-columns";
import { installFeatures } from "~/features/registry";
import { mock } from "~/lib/test/mock-schema";
import { getEntityListItemSchema } from "~/server/entity-reads/list-contracts";
const ledgerPartyListItem = getEntityListItemSchema("ledgerParty");
const mealListItem = getEntityListItemSchema("meal");
const productListItem = getEntityListItemSchema("product");

import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";

installFeatures();
const queryClient = createEditorTestQueryClient();

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
    meta: {
      hasNextPage: false,
      pageIndex: 0,
      pageSize: 100,
      totalCount: rows.length,
    },
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

describe("listPage", () => {
  it("discloses incomplete counts and switches between known and unresolved records", async () => {
    const party = mock(ledgerPartyListItem, {
      overrides: {
        id: testShortcode("ledgerParty", "LPY-4K7M"),
        name: "Synthetic unresolved party",
        fields: {
          displayImages: fieldValueFixture(
            entityFieldEnvelopeSchemas.ledgerParty.list.shape.fields.shape
              .displayImages,
            [],
          ),
        },
      },
    });
    const operation: ListQueryOptionsFn<object, typeof party> = (params) => ({
      queryKey: ["browser-test", "membership", params],
      execute: async () => ({
        items: params.resultMembership === "unresolved" ? [party] : [],
        meta: {
          hasNextPage: false,
          pageIndex: 0,
          pageSize: 100,
          totalCount: params.resultMembership === "unresolved" ? 1 : 0,
          unresolvedCount: 1,
        },
      }),
    });
    await renderListPage(
      "ledgerParty",
      "/ledger-parties?view=table",
      [],
      operation,
    );
    expect(
      await screen.findByText("Count incomplete · 1 unresolved"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show unresolved" }));
    expect(await screen.findByText("Synthetic unresolved party")).toBeVisible();
    expect(screen.getByText("Showing unresolved records")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show known matches" }));
    await waitFor(() =>
      expect(screen.queryByText("Synthetic unresolved party")).toBeNull(),
    );
    expect(screen.getByText("Count incomplete · 1 unresolved")).toBeVisible();
  });

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
        fields: {
          displayImages: fieldValueFixture(
            entityFieldEnvelopeSchemas.ledgerParty.list.shape.fields.shape[
              "displayImages"
            ],
            [],
          ),
        },
        id: testShortcode("ledgerParty", "LPY-4K7M"),
        name: "Example party",
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
      const config = identityListConfig(queryClient, entity, {
        generatedCrud,
        flatRows,
      });
      expect(config.titleField).toBe(titleField);
      expect(config.canAutoEdit).toBe(canAutoEdit);
    },
  );

  it("maps an explicit identity edit to its stored field", () => {
    expect(mealNameUpdate("  ")).toEqual({ name: null });
  });

  const meal = mock(mealListItem, {
    overrides: {
      fields: {
        mealType: fieldValueFixture(
          entityFieldEnvelopeSchemas.meal.list.shape.fields.shape["mealType"],
          "dinner",
        ),
        mealKind: fieldValueFixture(
          entityFieldEnvelopeSchemas.meal.list.shape.fields.shape["mealKind"],
          "cooked",
        ),
        costTotalLabel: fieldValueFixture(
          entityFieldEnvelopeSchemas.meal.list.shape.fields.shape[
            "costTotalLabel"
          ],
          "$18.50",
        ),
        displayImages: fieldValueFixture(
          entityFieldEnvelopeSchemas.meal.list.shape.fields.shape[
            "displayImages"
          ],
          [],
        ),
      },
      id: testShortcode("meal", "ML-4K7M"),
      date: "2026-08-18",
      name: "Weeknight Supper",

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
        fields: {
          cost: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape.cost,
            { kind: "item", amount: 42 },
          ),
          price: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape["price"],
            42,
          ),
          categoryId: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
              "categoryId"
            ],
            categoryReadFixture("household").id,
          ),
          displayImages: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
              "displayImages"
            ],
            [],
          ),
        },
        id: testShortcode("product", "PRD-4K7M"),
        name: "Cast iron skillet",

        category: categoryReadFixture("household"),
        externalIds: [],
      },
    });
    const unpriced = mock(productListItem, {
      overrides: {
        fields: {
          cost: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape.cost,
            null,
          ),
          price: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape["price"],
            null,
          ),
          categoryId: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
              "categoryId"
            ],
            categoryReadFixture("tools").id,
          ),
          displayImages: fieldValueFixture(
            entityFieldEnvelopeSchemas.product.list.shape.fields.shape[
              "displayImages"
            ],
            [],
          ),
        },
        id: testShortcode("product", "PRD-ZX4C"),
        name: "Mystery gadget",

        category: categoryReadFixture("tools"),
        externalIds: [],
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
      within(gadgetCard!).getByText(categoryText(unpriced.category)),
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
        meta: {
          hasNextPage: false,
          pageIndex: 0,
          pageSize: 10,
          totalCount: 37,
        },
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
