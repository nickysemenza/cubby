import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(
  (): {
    product: { current?: ProductWithFoodOut };
    previewQuery: Mock<(entity: string, id: string) => void>;
    auditLog: Mock<(props: unknown) => void>;
    nestedPage: Mock<(props: unknown) => void>;
  } => ({
    product: {},
    previewQuery: vi.fn(),
    auditLog: vi.fn(),
    nestedPage: vi.fn(),
  }),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.product.current, isLoading: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    hash,
  }: {
    children?: ReactNode;
    to: string;
    hash?: string;
  }) => <a href={`${to}${hash ? `#${hash}` : ""}`}>{children}</a>,
}));
vi.mock("~/entities/entity-query", () => ({
  entityPreviewQueryOptions: (entity: string, id: string) => {
    mocks.previewQuery(entity, id);
    return { queryKey: [entity, id] };
  },
}));
vi.mock("~/app/_components/audit-log/audit-log-list", () => ({
  AuditLogList: (props: unknown) => {
    mocks.auditLog(props);
    return <div data-testid="audit-log" />;
  },
}));
vi.mock("~/components/page/Page", () => ({
  Page: (props: unknown) => {
    mocks.nestedPage(props);
    return <div data-testid="nested-page" />;
  },
}));

import {
  ProductRelationshipRoute,
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

beforeEach(() => {
  mocks.product.current = product;
  mocks.previewQuery.mockClear();
  mocks.auditLog.mockClear();
  mocks.nestedPage.mockClear();
});

describe("ProductWorkbenchInspector", () => {
  it("uses the product detail query, renders exactly three tabs, and never nests Page", () => {
    render(<ProductWorkbenchInspector productId={product.id} />);

    expect(mocks.previewQuery).toHaveBeenCalledWith("product", product.id);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Relations",
      "Activity",
    ]);
    expect(mocks.nestedPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nested-page")).not.toBeInTheDocument();
  });

  it("renders route branches only when the embedded Product detail proves them", () => {
    const { rerender } = render(<ProductRelationshipRoute product={product} />);

    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByText("Also a location")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Stock.*Tool cabinet/ }),
    ).toHaveAttribute("href", "/inventory/$shortcode");
    expect(
      screen.getByRole("link", { name: /Also a location.*Drill case/ }),
    ).toHaveAttribute("href", "/locations/$shortcode");

    rerender(
      <ProductRelationshipRoute
        product={productWithFoodOut.parse({
          ...product,
          inventoryEntry: [],
          servingAsLocations: [],
        })}
      />,
    );

    expect(screen.queryByText("Stock")).not.toBeInTheDocument();
    expect(screen.queryByText("Also a location")).not.toBeInTheDocument();
  });

  it("does not mount relation or activity query components until their tab is active", () => {
    render(<ProductWorkbenchInspector productId={product.id} />);

    expect(mocks.auditLog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(
      screen.getByText("Direct relationship sections"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Derived relationship sections"),
    ).toBeInTheDocument();
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
