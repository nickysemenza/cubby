import {
  type ProductRelationshipRouteOut,
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { product as productOperations } from "~/app/products/product.functions";
import { entityDetail } from "~/entities/entity-detail.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductRelationshipRouteOperations,
  ProductRelationshipRoute,
  ProductRelationshipRouteFrame,
  type RouteBranch,
} from "./product-relationship-route";
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
  manufacturer: "Example Tools",
  model: "D-12",
  notes: "Store near the fasteners.",
  expectedQuantity: null,
  category: "tools",
  images: [],
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

const relationshipRoute: ProductRelationshipRouteOut = {
  productId: product.id,
  direct: {
    inventory: {
      count: 1,
      stockCount: 1,
      installedCount: 0,
      preview: [
        {
          id: testShortcode("inventory", "INV-INSPECT"),
          amount: { value: 1, unit: "each" },
          placement: "stock",
          location: {
            id: testShortcode("location", "LOC-INSPECT"),
            name: "Tool cabinet",
          },
        },
      ],
    },
    identityLocations: {
      count: 1,
      preview: [
        {
          id: testShortcode("location", "LOC-IDENTITY"),
          name: "Drill case",
        },
      ],
    },
    expenses: {
      count: 1,
      netCost: 99,
      preview: [
        {
          id: testShortcode("expense", "EXP-INSPECT"),
          name: "Tool expense",
          cost: 99,
          date: "2026-01-01",
          project: null,
        },
      ],
    },
    purchases: {
      count: 1,
      preview: [
        {
          id: testShortcode("purchase", "PUR-INSPECT"),
          displayLabel: "Workshop order",
          orderId: "A-12",
          date: "2026-01-01",
          vendor: {
            id: testShortcode("vendor", "VEN-INSPECT"),
            name: "Tool supply",
          },
          source: "both",
          linkAttachedAt: new Date("2026-01-01"),
        },
      ],
    },
    usedOnProjects: {
      count: 1,
      preview: [
        {
          id: testShortcode("project", "PRJ-INSPECT"),
          name: "Garage refresh",
          status: "in_progress",
        },
      ],
    },
    tasks: { count: 0, openCount: 0, preview: [] },
  },
  derived: {
    purchasedForProjects: {
      count: 0,
      preview: [],
      unassignedExpenseCount: 2,
    },
    vendors: {
      count: 0,
      preview: [],
    },
  },
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function relationshipOperations(
  route: ProductRelationshipRouteOut = relationshipRoute,
): ProductRelationshipRouteOperations {
  return {
    relationshipRoute: productOperations.relationshipRoute.withTransport(
      async () => route,
    ),
  };
}

function inspectorOperations(
  route: ProductRelationshipRouteOut = relationshipRoute,
): ProductWorkbenchInspectorOperations {
  return {
    productDetail: entityDetail.detail
      .forEntity("product")
      .withTransport(async () => product),
    ...relationshipOperations(route),
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

function renderRelationshipRoute(
  route: ProductRelationshipRouteOut = relationshipRoute,
) {
  return render(
    <ProductRelationshipRoute
      product={product}
      operations={relationshipOperations(route)}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("ProductWorkbenchInspector", () => {
  it("renders exactly three local inspector tabs without a page-level relationship route", async () => {
    renderInspector();

    await screen.findByRole("navigation", {
      name: `${product.name} direct relationships`,
    });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Relations",
      "Activity",
    ]);
    expect(
      screen.getByRole("navigation", {
        name: `${product.name} direct relationships`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Relationship route" }),
    ).not.toBeInTheDocument();
    const truth = screen.getByTestId("product-inspector-truth");
    const relationshipStrip = screen.getByRole("navigation", {
      name: `${product.name} direct relationships`,
    });
    expect(
      truth.compareDocumentPosition(relationshipStrip) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("caps the inspector strip at three direct destinations and reveals Relations locally", async () => {
    renderInspector();

    const strip = await screen.findByRole("navigation", {
      name: `${product.name} direct relationships`,
    });
    expect(
      within(strip).getByRole("link", { name: "Direct Stock: 1 records" }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole("link", {
        name: "Direct Also a location: 1 records",
      }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole("link", { name: "Direct Expenses: 1 records" }),
    ).toBeInTheDocument();
    expect(within(strip).queryByText("Purchases")).not.toBeInTheDocument();
    expect(within(strip).getByText("+2 more")).toBeInTheDocument();

    fireEvent.click(within(strip).getByRole("button", { name: "View all" }));

    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Purchases/ })).toBeVisible();
  });

  it("links compact-strip overflow to the canonical Relationships section without a local tab", async () => {
    const directDestinations = [
      { id: "stock", label: "Stock", kind: "direct", count: 1 },
      {
        id: "identity-locations",
        label: "Also a location",
        kind: "direct",
        count: 1,
      },
      {
        id: "expenses",
        label: "Expenses",
        kind: "direct",
        count: 1,
      },
      {
        id: "purchases",
        label: "Purchases",
        kind: "direct",
        count: 1,
      },
    ] satisfies ReadonlyArray<
      Pick<RouteBranch, "id" | "label" | "kind" | "count">
    >;
    const direct: RouteBranch[] = directDestinations.map((branch) => ({
      ...branch,
      samples: [],
      detailHash: "relationships",
      emptyCopy: "None.",
    }));

    render(
      <ProductRelationshipRouteFrame
        product={product}
        direct={direct}
        derived={[]}
        variant="strip"
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("link", {
        name: "View all direct relationships",
      }),
    ).toHaveAttribute("href", `/products/${product.id}#relationships`);
  });

  it("renders direct relationship branches with provenance and derived branches separately", async () => {
    renderRelationshipRoute();

    await screen.findByRole("button", { name: /^Stock/ });
    expect(screen.getByRole("button", { name: /^Stock/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Also a location/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Purchases/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Expense + order link")).toBeInTheDocument();
    expect(screen.getByText("Derived from those records")).toBeInTheDocument();
    expect(screen.getByText("Vendors")).toBeInTheDocument();
    const vendors = screen.getByRole("button", { name: /Vendors/ });
    expect(vendors).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(vendors);
    expect(
      screen.getByText("No vendor rollups from product spend yet."),
    ).toBeInTheDocument();
    const purchasedForProjects = screen.getByRole("button", {
      name: /Purchased for projects/,
    });
    expect(purchasedForProjects).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(purchasedForProjects);
    expect(
      screen.getByText("2 acquisition expenses not assigned to a project."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: /acquisition expenses not assigned to a project/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Used on projects")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Direct Stock: Tool cabinet" }),
    ).toHaveAttribute(
      "href",
      `/inventory/${relationshipRoute.direct.inventory.preview[0]?.id}`,
    );
  });

  it("keeps embedded stock and location evidence available when the route request fails", async () => {
    const failedOperations: ProductRelationshipRouteOperations = {
      relationshipRoute: productOperations.relationshipRoute.withTransport(
        async () => {
          throw new Error("relationship route unavailable");
        },
      ),
    };
    render(
      <ProductRelationshipRoute
        product={product}
        operations={failedOperations}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText("Other relationships could not be loaded."),
    ).toBeVisible();
    expect(screen.getByText("Tool cabinet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });

  it("keeps the shared relationship result ready while activity stays lazy", async () => {
    renderInspector();

    await screen.findByRole("navigation", {
      name: `${product.name} direct relationships`,
    });
    expect(screen.queryByText("No activity yet")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Relationship route")).toBeInTheDocument();
    expect(screen.getByText("Derived from those records")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("No activity yet")).toBeVisible();
    expect(
      screen.queryByText("Direct relationship sections"),
    ).not.toBeInTheDocument();
  });
});
