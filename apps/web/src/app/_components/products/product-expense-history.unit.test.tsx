import {
  type ProductWithFoodOut,
  productWithFoodOut,
} from "@cubby/schemas/product";
import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ExpenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks: {
  expenses: { current: ExpenseOut[] };
  membership: { current: KitMembershipOut[] };
} = vi.hoisted(() => ({
  expenses: { current: [] },
  membership: { current: [] },
}));

vi.mock("@tanstack/react-query", () => ({
  mutationOptions: (options: unknown) => options,
  useQuery: (options: { queryKey: unknown[] }) => ({
    data:
      options.queryKey[0] === "chartData"
        ? mocks.expenses.current
        : options.queryKey[0] === "kitMembership"
          ? mocks.membership.current
          : undefined,
    isPending: false,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("~/app/expenses/expense.functions", () => ({
  expense: {
    chartData: {
      queryOptions: (input: unknown) => ({
        queryKey: ["chartData", input],
      }),
    },
  },
}));

vi.mock("~/app/products/product.functions", () => ({
  product: {
    kitMembership: {
      queryOptions: (input: unknown) => ({
        queryKey: ["kitMembership", input],
      }),
    },
  },
}));

// This suite only exercises the empty/table-vs-empty branches, not the table
// itself — `useClientEntityList` and `RTable` are heavy, router/URL-state
// machinery that a table-shape test elsewhere already covers.
vi.mock("~/app/_components/hooks/useClientEntityList", () => ({
  useClientEntityList: () => ({
    workbench: {
      entity: "expense",
      table: {
        getSortedRowModel: () => ({ flatRows: [] }),
        state: { pagination: { pageSize: 25 } },
        setPageIndex: vi.fn(),
        resetRowSelection: vi.fn(),
      },
      bulkActionBar: null,
      deleteDialog: null,
    },
  }),
}));

vi.mock("~/app/_components/data-table/Table", () => ({
  default: () => <div data-testid="rtable" />,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
  }: {
    entity: string;
    data: { id: string; name: string };
  }) => (
    <a href={`/${entity}s/${data.id}`} data-entity={entity}>
      {data.name}
    </a>
  ),
}));

import { ProductExpenseHistory } from "./product-expense-history";

const COMBO_ID = testShortcode("product", "PRD-COMB");

const product: ProductWithFoodOut = productWithFoodOut.parse({
  id: testShortcode("product", "PRD-BATT"),
  name: "Battery Pack",
  aliases: [],
  tags: [],
  primaryGtin: null,
  fdc_id: null,
  manufacturer: "Milwaukee",
  model: null,
  notes: null,
  expectedQuantity: null,
  category: "tools",
  images: [],
  externalIds: [],
  price: null,
  pricing: {
    derivedPrice: null,
    effectivePrice: null,
    source: "none",
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
  inventoryEntry: [],
  servingAsLocations: [],
  componentCount: 0,
  food: null,
  recipeUsages: [],
  cookbook: null,
  quantityLedger: {
    acquiredUnits: 0,
    exitedUnits: 0,
    expectedQuantity: 0,
    unknownAcquisitionLines: 0,
    unknownExitLines: 0,
    locationCount: 0,
  },
  onHandUnits: 0,
  quantityVariance: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

const membershipEntry: KitMembershipOut = {
  parentProductId: COMBO_ID,
  parentProductName: "18V Combo Kit",
  manufacturer: "Milwaukee",
  quantity: 2,
  coverImageUrl: null,
  attachedAt: new Date("2026-01-01"),
  price: 249,
  expenseCount: 1,
  purchase: null,
};

const expense: ExpenseOut = {
  id: testShortcode("expense", "EXP-2345"),
  name: "Battery pack",
  cost: 49,
  date: "2026-07-31",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  productId: testShortcode("product", "PRD-BATT"),
  productQuantity: 1,
  vendor: "Home Depot",
  orderId: "#123",
  orderUrl: null,
  purchaseId: testShortcode("purchase", "PUR-2345"),
  purchaseDate: "2026-07-29",
  purchaseDisplayLabel: null,
  vendorId: testShortcode("vendor", "VEN-2345"),
  vendorLogo: null,
  projectName: null,
  productName: "Battery Pack",
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  createdAt: new Date("2026-07-31T12:00:00Z"),
  updatedAt: new Date("2026-07-31T12:00:00Z"),
};

const renderWith = (
  expenses: ExpenseOut[],
  membership: KitMembershipOut[] = [],
) => {
  mocks.expenses.current = expenses;
  mocks.membership.current = membership;
  return render(<ProductExpenseHistory product={product} />);
};

describe("ProductExpenseHistory empty states", () => {
  it("shows the ordinary empty state for a plain product with no expenses", () => {
    renderWith([]);

    expect(screen.getByText("No expenses linked")).toBeInTheDocument();
    expect(
      screen.getByText("Link one to track this product's cost basis."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No expenses of its own"),
    ).not.toBeInTheDocument();
  });

  it("names the kit and explains the derived share when the product is a kit component", () => {
    renderWith([], [membershipEntry]);

    expect(screen.getByText("No expenses of its own")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "18V Combo Kit" })).toHaveAttribute(
      "href",
      `/products/${COMBO_ID}`,
    );
    expect(screen.getByText(/derived share/)).toBeInTheDocument();
    expect(screen.getByText("See the kit's expenses →")).toBeInTheDocument();
    expect(screen.queryByText("No expenses linked")).not.toBeInTheDocument();
  });

  it("doesn't offer a ledger link when the kit itself has no expenses yet", () => {
    renderWith([], [{ ...membershipEntry, expenseCount: 0 }]);

    expect(screen.getByText("No expenses of its own")).toBeInTheDocument();
    expect(
      screen.queryByText("See the kit's expenses →"),
    ).not.toBeInTheDocument();
  });

  it("renders the table instead of an empty state when expenses exist", () => {
    renderWith([expense]);

    expect(screen.getByTestId("rtable")).toBeInTheDocument();
    expect(screen.queryByText("No expenses linked")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No expenses of its own"),
    ).not.toBeInTheDocument();
  });
});
