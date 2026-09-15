import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityDetail } from "~/entities/entity-detail.functions";
import { entityGraph } from "~/entities/entity-graph.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductWorkbenchInspectorOperations,
  ProductWorkbenchInspector,
} from "./product-workbench-inspector";

const product: ProductWithFoodOut = productWithFoodOut.parse({
  id: testShortcode("product", "PRD-INSPECT"),
  name: "Sample drill",
  aliases: [],
  tags: ["workshop"],
  primaryGtin: null,
  fdc_id: null,
  growsIngredientId: null,
  manufacturer: "Example Tools",
  model: "D-12",
  notes: "Store near the fasteners.",
  labelNutrition: null,
  expectedQuantity: null,
  category: "tools",
  images: [],
  coverImageUrl: null,
  externalIds: [],
  price: 99,
  pricing: {
    effectivePrice: 99,
    derivedPrice: null,
    source: "explicit",
    knownExpenseCount: 0,
    unknownExpenseCount: 0,
    knownUnitCount: 0,
    partial: false,
  },
  usdaUnavailable: null,
  stockTracked: null,
  dataQuality: {
    status: "complete",
    facets: [],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  },
  ingredient: null,
  unitMappings: [],
  inventoryEntry: [
    {
      id: testShortcode("inventory", "INV-INSPECT"),
      amount: { value: 1, unit: "each" },
      valuation: 99,
      verifiedAt: null,
      placement: "stock",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      location: {
        id: testShortcode("location", "LOC-INSPECT"),
        name: "Tool cabinet",
        aliases: [],
        tags: [],
        type: null,
        product: null,
        lastBulkInventory: null,
        aiDescription: null,
        gardenKind: null,
        gardenConditions: null,
        images: [],
        valuation: null,
        displayImage: null,
        ancestors: [],
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    },
  ],
  servingAsLocations: [
    {
      id: testShortcode("location", "LOC-IDENTITY"),
      name: "Drill case",
      type: null,
      displayImage: null,
      ancestors: [],
    },
  ],
  componentCount: 2,
  food: null,
  recipeUsages: [],
  cookbooks: [],
  quantityLedger: {
    acquiredUnits: 1,
    exitedUnits: 0,
    expectedQuantity: 1,
    unknownAcquisitionLines: 0,
    unknownExitLines: 0,
    locationCount: 2,
  },
  onHandUnits: 1,
  quantityVariance: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function inspectorOperations(): ProductWorkbenchInspectorOperations {
  const root = { entityType: "product" as const, entityId: product.id };
  const graph: import("@cubby/schemas/entity-graph").EntityGraphOutput = {
    nodes: [{ ...root, label: product.name, metadata: {} }],
    edges: [],
    branches: [
      {
        root,
        relationshipKey: "inventory",
        target: "inventory",
        label: "Stock",
        items: [],
        totalCount: 1,
        edgeIds: [],
        nextOffset: null,
      },
      {
        root,
        relationshipKey: "locations",
        target: "location",
        label: "Also a location",
        items: [],
        totalCount: 1,
        edgeIds: [],
        nextOffset: null,
      },
      {
        root,
        relationshipKey: "expenses",
        target: "expense",
        label: "Expenses",
        items: [],
        totalCount: 1,
        edgeIds: [],
        nextOffset: null,
      },
      {
        root,
        relationshipKey: "purchases",
        target: "purchase",
        label: "Purchases",
        items: [],
        totalCount: 1,
        edgeIds: [],
        nextOffset: null,
      },
      {
        root,
        relationshipKey: "project-uses",
        target: "project",
        label: "Used on projects",
        items: [],
        totalCount: 1,
        edgeIds: [],
        nextOffset: null,
      },
    ],
    truncated: false,
  };
  return {
    productDetail: entityDetail.detail
      .forEntity("product")
      .withTransport(async () => ({
        ...product,
        displayImages: [],
        attachments: [],
      })),
    graph: entityGraph.graph.withTransport(async () => graph),
    explore: entityGraph.explore.withTransport(async ({ input }) => ({
      ...graph,
      paths: [],
      completion: {
        status: "depth-limit",
        requestedDepth: input.depth,
        reachedDepth: 1,
      },
    })),
  };
}

function renderInspector(
  operations: ProductWorkbenchInspectorOperations = inspectorOperations(),
) {
  return render(
    <ProductWorkbenchInspector
      productId={product.id}
      operations={operations}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("ProductWorkbenchInspector", () => {
  it("renders exactly three local inspector tabs without a page-level relationship route", async () => {
    renderInspector();

    await screen.findByRole("navigation", {
      name: `${product.name} relationships`,
    });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Relations",
      "Activity",
    ]);
    expect(
      screen.getByRole("navigation", {
        name: `${product.name} relationships`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Relationship route" }),
    ).not.toBeInTheDocument();
    const truth = screen.getByTestId("product-inspector-truth");
    const relationshipStrip = screen.getByRole("navigation", {
      name: `${product.name} relationships`,
    });
    expect(
      truth.compareDocumentPosition(relationshipStrip) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("caps the inspector strip at three direct destinations and reveals Relations locally", async () => {
    renderInspector();

    const strip = await screen.findByRole("navigation", {
      name: `${product.name} relationships`,
    });
    expect(
      within(strip).getByRole("button", { name: "Stock 1" }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole("button", { name: "Also a location 1" }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole("button", { name: "Expenses 1" }),
    ).toBeInTheDocument();
    expect(within(strip).queryByText("Purchases")).not.toBeInTheDocument();
    expect(within(strip).getByText("+2 more")).toBeInTheDocument();

    fireEvent.click(within(strip).getByRole("button", { name: "View all" }));

    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("heading", { name: "Purchases" }),
    ).toBeVisible();
  });

  it("keeps loaded product truth available when graph loading fails", async () => {
    const operations = inspectorOperations();
    renderInspector({
      ...operations,
      graph: entityGraph.graph.withTransport(async () => {
        throw new Error("unavailable");
      }),
    });
    expect(await screen.findByTestId("product-inspector-truth")).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Retry connections" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open full product details" }),
    ).toHaveAttribute("href", `/products/${product.id}`);
  });

  it("keeps the shared relationship result ready while activity stays lazy", async () => {
    renderInspector();

    await screen.findByRole("navigation", {
      name: `${product.name} relationships`,
    });
    expect(screen.queryByText("No activity yet")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(
      await screen.findByRole("button", { name: "List view" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Graph view" })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await waitFor(() => {
      expect(screen.getByText("No activity yet")).toBeVisible();
    });
    expect(
      screen.queryByText("Direct relationship sections"),
    ).not.toBeInTheDocument();
  });
});
