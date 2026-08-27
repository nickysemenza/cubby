import {
  type ProductRelationshipRouteOut,
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(
  (): {
    product: { current?: ProductWithFoodOut };
    route: { current?: ProductRelationshipRouteOut };
    previewQuery: Mock<(entity: string, id: string) => void>;
    relationshipQuery: Mock<(input: { productId: string }) => void>;
    refetch: Mock<() => void>;
    routeError: boolean;
    auditLog: Mock<(props: unknown) => void>;
    nestedPage: Mock<(props: unknown) => void>;
  } => ({
    product: {},
    route: {},
    previewQuery: vi.fn(),
    relationshipQuery: vi.fn(),
    refetch: vi.fn(),
    routeError: false,
    auditLog: vi.fn(),
    nestedPage: vi.fn(),
  }),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: string[] }) =>
    options.queryKey?.[0] === "relationship-route"
      ? {
          data: mocks.route.current,
          isPending: false,
          isError: mocks.routeError,
          refetch: mocks.refetch,
        }
      : { data: mocks.product.current, isLoading: false },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    hash,
    params,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    hash?: string;
    params?: { shortcode?: string };
    [key: string]: unknown;
  }) => (
    <a
      {...props}
      data-router-link="true"
      href={`${params?.shortcode ? to.replace("$shortcode", params.shortcode) : to}${hash ? `#${hash}` : ""}`}
    >
      {children}
    </a>
  ),
}));
vi.mock("~/entities/entity-query", () => ({
  entityPreviewQueryOptions: (entity: string, id: string) => {
    mocks.previewQuery(entity, id);
    return { queryKey: [entity, id] };
  },
}));
vi.mock("~/app/products/product.functions", () => ({
  product: {
    relationshipRoute: {
      queryOptions: (input: { productId: string }) => {
        mocks.relationshipQuery(input);
        return { queryKey: ["relationship-route", input.productId] };
      },
    },
  },
}));
vi.mock("~/app/_components/audit-log/audit-log-list", () => ({
  AuditLogList: (props: unknown) => {
    mocks.auditLog(props);
    return <div data-testid="audit-log" />;
  },
}));

vi.mock("../actions/entity-actions", () => ({
  EntityActionButtons: () => <div data-testid="product-inspector-actions" />,
}));
vi.mock("~/components/page/Page", () => ({
  Page: (props: unknown) => {
    mocks.nestedPage(props);
    return <div data-testid="nested-page" />;
  },
}));

import {
  ProductRelationshipRoute,
  ProductRelationshipRouteFrame,
} from "./product-relationship-route";
import { ProductWorkbenchInspector } from "./product-workbench-inspector";

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
  cookbook: null,
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

beforeEach(() => {
  mocks.product.current = product;
  mocks.route.current = relationshipRoute;
  mocks.previewQuery.mockClear();
  mocks.relationshipQuery.mockClear();
  mocks.refetch.mockClear();
  mocks.routeError = false;
  mocks.auditLog.mockClear();
  mocks.nestedPage.mockClear();
});

describe("ProductWorkbenchInspector", () => {
  it("uses the product detail query, renders exactly three tabs, and never nests Page", () => {
    render(<ProductWorkbenchInspector productId={product.id} />);

    expect(mocks.previewQuery).toHaveBeenCalledWith("product", product.id);
    expect(mocks.relationshipQuery).toHaveBeenCalledTimes(1);
    expect(mocks.relationshipQuery).toHaveBeenCalledWith({
      productId: product.id,
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
    expect(mocks.nestedPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nested-page")).not.toBeInTheDocument();
  });

  it("caps the inspector strip at three direct destinations and reveals Relations locally", () => {
    render(<ProductWorkbenchInspector productId={product.id} />);

    const strip = screen.getByRole("navigation", {
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

  it("links compact-strip overflow to the canonical Relationships section without a local tab", () => {
    const direct = [
      { id: "stock", label: "Stock", kind: "direct" as const, count: 1 },
      {
        id: "identity-locations",
        label: "Also a location",
        kind: "direct" as const,
        count: 1,
      },
      {
        id: "expenses",
        label: "Expenses",
        kind: "direct" as const,
        count: 1,
      },
      {
        id: "purchases",
        label: "Purchases",
        kind: "direct" as const,
        count: 1,
      },
    ].map((branch) => ({
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
    );

    expect(
      screen.getByRole("link", { name: "View all direct relationships" }),
    ).toHaveAttribute("href", `/products/${product.id}#relationships`);
  });

  it("renders direct relationship branches with provenance and derived branches separately", () => {
    const { rerender } = render(<ProductRelationshipRoute product={product} />);

    expect(mocks.relationshipQuery).toHaveBeenCalledWith({
      productId: product.id,
    });
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
    rerender(
      <ProductRelationshipRoute
        product={productWithFoodOut.parse({
          ...product,
          category: "household",
        })}
      />,
    );
    expect(screen.getByText("Used on projects")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Direct Stock: Tool cabinet" }),
    ).toHaveAttribute(
      "href",
      `/inventory/${relationshipRoute.direct.inventory.preview[0]?.id}`,
    );
    expect(
      screen.getByRole("link", { name: "Direct Stock: Tool cabinet" }),
    ).toHaveAttribute("data-router-link", "true");

    mocks.route.current = {
      ...relationshipRoute,
      direct: {
        ...relationshipRoute.direct,
        inventory: {
          ...relationshipRoute.direct.inventory,
          count: 0,
          preview: [],
        },
        identityLocations: {
          ...relationshipRoute.direct.identityLocations,
          count: 0,
          preview: [],
        },
      },
    };
    rerender(<ProductRelationshipRoute product={product} />);

    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByText("No stock records yet.")).toBeInTheDocument();
    expect(screen.getByText("Also a location")).toBeInTheDocument();
    expect(
      screen.getByText("This product does not identify a location."),
    ).toBeInTheDocument();
    const stockBranch = screen
      .getByRole("button", { name: /^Stock0$/ })
      .closest("li");
    expect(stockBranch).not.toBeNull();
    expect(
      within(stockBranch as HTMLElement).queryByRole("link"),
    ).not.toBeInTheDocument();
  });

  it("keeps embedded stock and location evidence available when the route request fails", () => {
    mocks.routeError = true;
    render(<ProductRelationshipRoute product={product} />);

    expect(
      screen.getByText("Other relationships could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByText("Tool cabinet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("keeps the shared relationship result ready while activity stays lazy", () => {
    render(<ProductWorkbenchInspector productId={product.id} />);

    expect(mocks.auditLog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Relationship route")).toBeInTheDocument();
    expect(screen.getByText("Derived from those records")).toBeInTheDocument();
    expect(mocks.auditLog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(mocks.auditLog).toHaveBeenCalledWith({
      entityType: "product",
      entityId: product.id,
      showEntityLink: false,
    });
    expect(
      screen.queryByText("Direct relationship sections"),
    ).not.toBeInTheDocument();
  });
});
