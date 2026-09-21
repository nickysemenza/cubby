import { foodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntityListCardDensityProvider } from "~/app/_components/entity-list/generic-entity-list";
import { listChromePage } from "~/app/_components/routing/entity-routes";
import { entitySearch } from "~/entities/generated/entity-search.gen";
import { usdaFood } from "~/entities/usda.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type USDAFoodListOperations,
  USDAFoodList,
  withUSDAListIdentity,
} from "./usdafoodlist";

const food = foodSummaryWithLinkedProducts.parse({
  fdc_id: 12345,
  description: "Example food",
  foodInfo: { data_type: "branded_food", description: "Example food" },
  legacyFoodInfo: null,
  brandedFoodInfo: null,
  nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
  portionInfoRaw: [],
  inferredUnitMappings: [],
  linkedProducts: [],
});

const operations: USDAFoodListOperations = {
  list: usdaFood.list.withTransport(async () => ({
    items: [food],
    meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
  })),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  class TestIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

describe("USDAFoodList", () => {
  it("adapts the external FDC identity to the shared list contract", () => {
    expect(withUSDAListIdentity(food)).toMatchObject({
      id: "12345",
      name: "Example food",
      description: "Example food",
    });
  });

  it("renders USDA identity and scan-ready classification through the real list", async () => {
    render(
      <EntityListCardDensityProvider>
        <USDAFoodList operations={operations} />
      </EntityListCardDensityProvider>,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(await screen.findByText("Example food")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "USDA Foods Table" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "12345" })).toHaveAttribute(
      "href",
      "/usda/12345",
    );
    // The declared `Type` filter now also renders as a band chip, so the
    // column is found by role rather than by text.
    expect(screen.getByRole("columnheader", { name: /Type/ })).toBeVisible();
  });

  it("keeps numeric USDA destinations and the existing query across card sizes", async () => {
    harness.dispose();
    const reads: unknown[] = [];
    const filteredOperations: USDAFoodListOperations = {
      list: usdaFood.list.withTransport(async ({ input }) => {
        reads.push(input);
        return {
          items: [food],
          meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
        };
      }),
    };
    const Page = listChromePage({
      title: "USDA Foods",
      entity: "usda-food",
      page: () => <USDAFoodList operations={filteredOperations} />,
    });
    harness = createBrowserTestHarness({
      initialPath:
        "/usda?view=shelf&description=Example&nameFilter=Example&dataTypeFilter=branded_food&foodsOnly=false&linkedProductsOnly=true",
      route: {
        path: "/usda",
        component: Page,
        validateSearch: entitySearch["usda-food"].schema.parse,
      },
    });
    await harness.loadRouter();
    render(<div />, { wrapper: harness.routerWrapper });
    const grid = await screen.findByTestId("entity-card-grid");
    expect(grid).toHaveTextContent("Example food");
    expect(reads.at(-1)).toMatchObject({
      filters: {
        nameFilter: "Example",
        dataTypeFilter: "branded_food",
        foodsOnly: false,
        linkedProductsOnly: true,
      },
    });
    expect(grid.querySelector('a[href="/usda/12345"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compact view" }));
    await waitFor(() => expect(grid).toHaveAttribute("data-compact", "true"));
    expect(harness.router.state.location.search).toMatchObject({
      view: "shelf",
      description: "Example",
    });
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(
      await screen.findByRole("table", { name: "USDA Foods Table" }),
    ).toBeVisible();
    expect(harness.router.state.location.search).toMatchObject({
      description: "Example",
    });
  });
});
