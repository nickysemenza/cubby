import {
  unsafeProductShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { flexRender } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  purchases: { current: [] as ProductPurchaseOut[] },
  membership: { current: [] as KitMembershipOut[] },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data:
      options.queryKey[0] === "purchases"
        ? mocks.purchases.current
        : options.queryKey[0] === "kitMembership"
          ? mocks.membership.current
          : undefined,
    isPending: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    product: {
      purchases: { queryOptions: () => ({ queryKey: ["purchases"] }) },
      kitMembership: { queryOptions: () => ({ queryKey: ["kitMembership"] }) },
    },
    purchase: {
      detachProducts: { mutationOptions: vi.fn() },
    },
  }),
}));

// The real link renders a hover-preview card that needs a query client; the
// name/href pair is all this test asserts on.
vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
  }: {
    entity: string;
    data: { id: string; name?: string; orderId?: string | null };
  }) => (
    <a href={`/${entity}s/${data.id}`} data-entity={entity}>
      {data.name ?? data.orderId ?? data.id}
    </a>
  ),
}));
vi.mock("~/app/_components/data-table/Table", () => ({
  default: ({
    table,
    emptyState,
  }: {
    table: {
      getRowModel: () => {
        rows: Array<{
          id: string;
          getVisibleCells: () => Array<{
            id: string;
            column: { columnDef: { cell?: unknown } };
            getContext: () => never;
          }>;
        }>;
      };
    };
    emptyState?: React.ReactNode;
  }) => {
    const rows = table.getRowModel().rows;
    if (rows.length === 0) return emptyState;
    return (
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(
                    cell.column.columnDef.cell as never,
                    cell.getContext(),
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
}));
vi.mock("~/app/_components/table/TableLink", () => ({
  TableLink: ({
    to,
    params,
    children,
  }: {
    to: string;
    params: { shortcode: string };
    children: React.ReactNode;
  }) => <a href={to.replace("$shortcode", params.shortcode)}>{children}</a>,
}));

import { ProductPurchases } from "./product-purchases";

const renderWith = (
  purchases: ProductPurchaseOut[],
  membership: KitMembershipOut[] = [],
) => {
  mocks.purchases.current = purchases;
  mocks.membership.current = membership;
  return render(<ProductPurchases productId="PRD-BATT" />);
};

const membershipEntry: KitMembershipOut = {
  parentProductId: unsafeProductShortcode("PRD-COMB"),
  parentProductName: "18V Combo Kit",
  manufacturer: "Milwaukee",
  quantity: 2,
  coverImageUrl: null,
  attachedAt: new Date("2026-01-01"),
  price: 249,
  expenseCount: 1,
  purchase: {
    purchaseId: unsafePurchaseShortcode("PUR-2345"),
    displayLabel: null,
    vendorName: "Home Depot",
    date: "2026-07-29",
    orderId: "#11325",
  },
};

describe("ProductPurchases empty states", () => {
  it("shows the ordinary empty state for a plain product with no purchases", () => {
    renderWith([]);

    expect(screen.getByText("No purchases recorded")).toBeInTheDocument();
    // "Linked" would now be wrong: the panel also lists orders derived from
    // this product's own acquisition expenses, so reaching this state means
    // neither source has anything.
    expect(
      screen.getByText(
        "No expense on this product names an order, and no order has been linked to it directly. Record the spend on an expense, or attach it from a purchase's Products section when the order was never itemized.",
      ),
    ).toBeInTheDocument();
  });

  it("points at the kit's purchase instead of inviting a direct attach, for a kit component", () => {
    renderWith([], [membershipEntry]);

    expect(screen.getByText("No purchases of its own")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "18V Combo Kit" })).toHaveAttribute(
      "href",
      "/products/PRD-COMB",
    );
    // The now-wrong "attach this product" advice must be gone.
    expect(
      screen.queryByText(
        "Attach this product from a purchase's Products section to record which order it came from.",
      ),
    ).not.toBeInTheDocument();
    // The kit's own purchase is linked directly.
    expect(screen.getByRole("link", { name: "#11325" })).toHaveAttribute(
      "href",
      "/purchases/PUR-2345",
    );
  });

  it("omits the purchase link when the kit itself has never been purchased", () => {
    renderWith([], [{ ...membershipEntry, purchase: null }]);

    expect(screen.getByText("No purchases of its own")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#11325" })).toBeNull();
  });

  it("renders the purchase list instead of an empty state when purchases exist", () => {
    renderWith([
      {
        purchaseId: unsafePurchaseShortcode("PUR-9999"),
        displayLabel: null,
        vendorName: "Amazon",
        date: "2026-08-01",
        orderId: "#999",
        source: "link",
        linkAttachedAt: new Date("2026-08-01"),
      },
    ]);

    expect(screen.getByRole("link", { name: "#999" })).toBeInTheDocument();
    expect(screen.queryByText("No purchases recorded")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No purchases of its own"),
    ).not.toBeInTheDocument();
  });

  it("badges only the explicitly-linked row, not the expense-derived one", () => {
    renderWith([
      {
        purchaseId: unsafePurchaseShortcode("PUR-LINK"),
        displayLabel: null,
        vendorName: "Ferguson",
        date: "2026-08-02",
        orderId: "#link",
        source: "link",
        linkAttachedAt: new Date("2026-08-02"),
      },
      {
        purchaseId: unsafePurchaseShortcode("PUR-EXPN"),
        displayLabel: null,
        vendorName: "Home Depot",
        date: "2026-08-01",
        orderId: "#expense",
        // Derived from an itemized acquisition Expense: nothing was ever
        // attached, so there is no link to stamp and none to remove.
        source: "expense",
        linkAttachedAt: null,
      },
    ]);

    expect(screen.getByRole("link", { name: "#link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#expense" })).toBeInTheDocument();
    // One badge for two rows — the marker belongs to the rarer, detachable kind.
    expect(screen.getAllByText("Linked")).toHaveLength(1);
  });

  // NOT tested here, deliberately: that the blank-header `link` column disables
  // sorting. A sortable column renders its header as a button labelled by the
  // header text, so a blank one is a button with no accessible name — Axe rates
  // it `serious`. This tier cannot see it: the `RTable` mock above renders only
  // `tbody`, so an assertion about header buttons passes whether or not the bug
  // is present (verified by reintroducing it). `tests/e2e/accessibility.smoke`
  // is the tier that can fail, and it is what caught this.
});
