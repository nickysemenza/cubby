import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { testShortcode } from "@cubby/schemas/testing";
import { flexRender } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks: {
  components: { current: ProductComponentOut[] };
  membership: { current: KitMembershipOut[] };
} = vi.hoisted(() => ({
  components: { current: [] },
  membership: { current: [] },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data:
      options.queryKey[0] === "kitMembership"
        ? mocks.membership.current
        : options.queryKey[0] === "components"
          ? mocks.components.current
          : undefined,
    isPending: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  // The descriptor builds its options through react-query's own
  // `mutationOptions`, so this partial mock has to carry it too.
  mutationOptions: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("~/app/products/product.functions", () => ({
  product: {
    components: {
      queryOptions: (input: unknown) => ({
        queryKey: ["components", input],
      }),
    },
    kitMembership: {
      queryOptions: (input: unknown) => ({
        queryKey: ["kitMembership", input],
      }),
    },
    search: {
      queryOptions: (input: unknown) => ({ queryKey: ["search", input] }),
    },
    attachComponents: { mutationOptions: () => ({}) },
    detachComponents: { mutationOptions: () => ({}) },
  },
}));

// Keep the table shell lightweight while exercising the real column
// definitions and TanStack row model used by the embedded roster.
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
// The real link renders a hover-preview card that needs a query client; the
// name and href are all this test asserts on.
vi.mock("../EntityInlineLink", () => ({
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

import { ProductKitComponents } from "./product-kit-components";

const DRILL_ID = testShortcode("product", "PRD-DRIL");
const COMBO_ID = testShortcode("product", "PRD-COMB");

/**
 * One component row. `onHandUnits` defaults to stocked so the existing cases
 * keep asserting what they were written to assert; the stock cases below pass
 * it explicitly.
 */
const component = (
  over: Partial<ProductComponentOut> & { productName: string },
): ProductComponentOut => ({
  productId: testShortcode("product", "PRD-CMP1"),
  manufacturer: "Milwaukee",
  quantity: 1,
  price: null,
  coverImageUrl: null,
  onHandUnits: 1,
  attachedAt: new Date("2026-01-01"),
  ...over,
});

const renderWith = (
  components: ProductComponentOut[],
  membership: KitMembershipOut[] = [],
) => {
  mocks.components.current = components;
  mocks.membership.current = membership;
  return render(<ProductKitComponents productId="PRD-KIT1" />);
};

describe("ProductKitComponents", () => {
  it("renders a kit with several components, each with its quantity", () => {
    renderWith([
      {
        productId: DRILL_ID,
        productName: "Bare Drill",
        manufacturer: "Milwaukee",
        quantity: 1,
        price: 89,
        coverImageUrl: "https://example.com/drill.png",
        onHandUnits: 1,
        attachedAt: new Date("2026-01-01"),
      },
      {
        productId: testShortcode("product", "PRD-BATT"),
        productName: "Battery Pack",
        manufacturer: "Milwaukee",
        quantity: 2,
        price: null,
        coverImageUrl: null,
        onHandUnits: 2,
        attachedAt: new Date("2026-01-01"),
      },
    ]);

    expect(screen.getByRole("link", { name: "Bare Drill" })).toHaveAttribute(
      "href",
      `/products/${DRILL_ID}`,
    );
    expect(screen.getByRole("link", { name: "Battery Pack" })).toBeVisible();
    expect(screen.getByText("×1")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Image" })).toHaveAttribute(
      "src",
      "https://example.com/drill.png",
    );
    expect(screen.queryByText("Not a kit")).not.toBeInTheDocument();
    // No membership rows: this product isn't listed inside any other kit.
    expect(
      screen.queryByText("Kits this product is listed inside."),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when the product has no components", () => {
    renderWith([]);

    expect(screen.getByText("Not a kit")).toBeInTheDocument();
  });

  it("shows the kits a product is listed inside, when it's part of one", () => {
    renderWith(
      [],
      [
        {
          parentProductId: COMBO_ID,
          parentProductName: "18V Combo Kit",
          manufacturer: "Milwaukee",
          quantity: 2,
          coverImageUrl: null,
          attachedAt: new Date("2026-01-01"),
          price: 249,
          expenseCount: 1,
          purchase: null,
        },
      ],
    );

    expect(
      screen.getByText("Kits this product is listed inside."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "18V Combo Kit" })).toHaveAttribute(
      "href",
      `/products/${COMBO_ID}`,
    );
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  /**
   * The three states a component's shelf can be in, and the one asymmetry that
   * matters: `0` is a real answer (that part is unaccounted for) while `—` means
   * the count is unanswerable because the entries carry incompatible units.
   * Collapsing the two would hide exactly the gap this column exists to show.
   *
   * Every row is priced so the only `—` on screen is the one under test.
   */
  it("renders each component's on-hand units, dashing only unanswerable ones", () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-STKD"),
        productName: "Stocked Part",
        price: 10,
        onHandUnits: 2,
      }),
      component({
        productId: testShortcode("product", "PRD-GONE"),
        productName: "Unaccounted Part",
        price: 11,
        onHandUnits: 0,
      }),
      component({
        productId: testShortcode("product", "PRD-MIXD"),
        productName: "Mixed Unit Part",
        price: 12,
        onHandUnits: null,
      }),
    ]);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("reports a fully-stocked kit as stocked by its components", () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-NST1"),
        productName: "Nightstand",
        quantity: 2,
        onHandUnits: 2,
      }),
    ]);

    expect(screen.getByText("Stocked as its components")).toBeInTheDocument();
  });

  it("counts the stocked parts when a kit is only partly accounted for", () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-BRDG"),
        productName: "Bridge",
        onHandUnits: 1,
      }),
      component({
        productId: testShortcode("product", "PRD-BULB"),
        productName: "Bulbs",
        quantity: 3,
        onHandUnits: 0,
      }),
    ]);

    expect(screen.getByText("1 of 2 components stocked")).toBeInTheDocument();
    expect(
      screen.queryByText("Stocked as its components"),
    ).not.toBeInTheDocument();
  });

  /**
   * A kit none of whose parts are on a shelf has nothing reassuring to say, and
   * a "0 of 2" chip would read as a defect badge on a kit that was simply sold
   * or consumed whole. The existing layout is already the right answer.
   */
  it("stays silent when no component is stocked", () => {
    renderWith([
      component({
        productId: testShortcode("product", "PRD-DRY1"),
        productName: "Dust Bags",
        onHandUnits: 0,
      }),
    ]);

    expect(
      screen.queryByText("Stocked as its components"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/components stocked/)).not.toBeInTheDocument();
  });

  /**
   * The membership table lists the KITS this product sits inside. Their own
   * stock is a different question with a different answer, so the column is off
   * — `KitMembershipOut` has no on-hand field to render in the first place.
   */
  it("never shows an on-hand column on the memberships table", () => {
    renderWith(
      [],
      [
        {
          parentProductId: COMBO_ID,
          parentProductName: "18V Combo Kit",
          manufacturer: "Milwaukee",
          quantity: 2,
          coverImageUrl: null,
          attachedAt: new Date("2026-01-01"),
          price: 249,
          expenseCount: 1,
          purchase: null,
        },
      ],
    );

    expect(screen.queryByText("On hand")).not.toBeInTheDocument();
  });
});
