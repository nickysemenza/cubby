import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rTable: vi.fn(),
  /** The row-action renderer `useClientEntityList` was handed. */
  extraActions: { current: null as ((row: never) => ReactNode) | null },
  /** The rows it was handed — grafted `StockedRow`s, not raw entries. */
  rows: { current: [] as unknown[] },
  /** The per-row selection guard, so a test can assert it, not just trust it. */
  rowIsEntity: { current: null as ((row: never) => boolean) | null },
  moveDialog: vi.fn(),
  deleteDialog: vi.fn(),
  discardDialog: vi.fn(),
  hierarchyDrilldown: vi.fn(),
}));

vi.mock("~/app/_components/data-table/Table", () => ({
  default: (props: unknown) => {
    mocks.rTable(props);
    return <div data-testid="rtable" />;
  },
}));
vi.mock("~/app/_components/visualizations/hierarchy-drilldown", () => ({
  HierarchyDrilldown: (props: unknown) => {
    mocks.hierarchyDrilldown(props);
    return <div data-testid="location-breakdown" />;
  },
}));
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: (e: { stopPropagation: () => void }) => void;
  }) => (
    <button type="button" onClick={() => onClick?.({ stopPropagation() {} })}>
      {children}
    </button>
  ),
}));
vi.mock("~/app/_components/hooks/useClientEntityList", () => ({
  useClientEntityList: (opts: {
    data: unknown[];
    extraActions?: (row: never) => ReactNode;
    rowIsEntity?: (row: never) => boolean;
  }) => {
    mocks.extraActions.current = opts.extraActions ?? null;
    mocks.rows.current = opts.data;
    mocks.rowIsEntity.current = opts.rowIsEntity ?? null;
    return {
      workbench: {
        entity: "inventory",
        table: {
          getRowModel: () => ({ rows: [] }),
          resetRowSelection: vi.fn(),
        },
        bulkActionBar: null,
        deleteDialog: null,
      },
      requestDelete: vi.fn(),
    };
  },
}));
vi.mock("~/app/_components/hooks/useUpdateMutation", () => ({
  useUpdateMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("~/app/_components/inventory/move-inventory-dialog", () => ({
  MoveInventoryDialog: (props: unknown) => {
    mocks.moveDialog(props);
    return null;
  },
}));
vi.mock("~/app/_components/inventory/delete-inventory-dialog", () => ({
  DeleteInventoryDialog: (props: unknown) => {
    mocks.deleteDialog(props);
    return null;
  },
}));
vi.mock("./product-discard-dialog", () => ({
  ProductDiscardDialog: (props: unknown) => {
    mocks.discardDialog(props);
    return null;
  },
}));

import { ProductStockedAt } from "./product-stocked-at";

const entry = (id: string, locationId: string) => ({
  id: unsafeInventoryShortcode(id),
  amount: { value: 2, unit: "each" },
  valuation: 10,
  verifiedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  location: {
    id: unsafeLocationShortcode(locationId),
    name: "shelf",
    ancestors: [],
  },
});

const product = {
  id: unsafeProductShortcode("PRD-AAAA"),
  name: "Bora Clamp",
  unitMappings: [],
  price: null,
  pricing: { effectivePrice: 26.26, derivedPrice: 26.26, source: "derived" },
  inventoryEntry: [
    entry("INV-AAAA", "LOC-AAAA"),
    entry("INV-BBBB", "LOC-BBBB"),
  ],
  servingAsLocations: [],
} as unknown as ProductWithFoodOut;

/** A product held only as bins in service — no loose stock at all. */
const locationsOnlyProduct = {
  ...product,
  inventoryEntry: [],
  servingAsLocations: [
    {
      id: unsafeLocationShortcode("LOC-CCCC"),
      name: "chrome wire shelf",
      type: null,
      ancestors: [],
    },
  ],
} as unknown as ProductWithFoodOut;

/**
 * Render the table, then fire one row action against the row the component
 * actually built — not the raw entry it was given, which is the whole point of
 * the grafting these tests cover.
 */
const fireRowAction = (label: string, rowIndex: number) => {
  render(<ProductStockedAt product={product} />);
  const row = mocks.rows.current[rowIndex];
  expect(row).toBeDefined();
  const menu = render(mocks.extraActions.current!(row as never));
  fireEvent.click(menu.getByText(label));
};

beforeEach(() => {
  for (const m of [
    mocks.rTable,
    mocks.moveDialog,
    mocks.deleteDialog,
    mocks.discardDialog,
    mocks.hierarchyDrilldown,
  ])
    m.mockClear();
  mocks.extraActions.current = null;
  mocks.rowIsEntity.current = null;
});

describe("ProductStockedAt", () => {
  it("renders the location breakdown above the editable entries table", () => {
    render(<ProductStockedAt product={product} />);
    expect(screen.getByTestId("location-breakdown")).toBeInTheDocument();
    expect(screen.getByTestId("rtable")).toBeInTheDocument();
    expect(mocks.hierarchyDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel: "Bora Clamp location breakdown",
        root: expect.objectContaining({ metricLabel: "4 each" }),
      }),
    );
  });

  it("renders the empty shelf state instead of a table when nothing is stocked", () => {
    render(
      <ProductStockedAt
        product={
          {
            ...product,
            inventoryEntry: [],
            servingAsLocations: [],
          } as ProductWithFoodOut
        }
      />,
    );
    expect(mocks.rTable).not.toHaveBeenCalled();
    expect(screen.getByText("Not stocked anywhere")).toBeInTheDocument();
  });

  it("tables a product held only as locations rather than calling it unstocked", () => {
    render(<ProductStockedAt product={locationsOnlyProduct} />);
    expect(screen.queryByText("Not stocked anywhere")).not.toBeInTheDocument();
    expect(mocks.rTable).toHaveBeenCalled();
    expect(mocks.rows.current).toHaveLength(1);
    expect(mocks.rows.current[0]).toMatchObject({
      kind: "identity",
      amount: { value: 1, unit: "each" },
    });
  });

  it("values an identity row at the effective price when there is no override", () => {
    render(<ProductStockedAt product={locationsOnlyProduct} />);
    expect(mocks.rows.current[0]).toMatchObject({ valuation: 26.26 });
  });

  it("lets the manual override win over the derived price", () => {
    render(
      <ProductStockedAt
        product={
          {
            ...locationsOnlyProduct,
            price: 40,
            pricing: {
              effectivePrice: 40,
              derivedPrice: 26.26,
              source: "explicit",
            },
          } as unknown as ProductWithFoodOut
        }
      />,
    );
    expect(mocks.rows.current[0]).toMatchObject({ valuation: 40 });
  });

  it("gives an identity row no row menu and no selection", () => {
    render(<ProductStockedAt product={locationsOnlyProduct} />);
    const row = mocks.rows.current[0];
    expect(row).toBeDefined();
    // No InventoryEntry behind it, so Move / Discard / Delete have nothing to
    // act on — the menu is absent rather than present and failing.
    expect(mocks.extraActions.current!(row as never)).toBeNull();
    expect(mocks.rowIsEntity.current!(row as never)).toBe(false);
  });

  it("still selects and offers the menu on a real stock row", () => {
    render(<ProductStockedAt product={product} />);
    const row = mocks.rows.current[0];
    expect(mocks.rowIsEntity.current!(row as never)).toBe(true);
    expect(mocks.extraActions.current!(row as never)).not.toBeNull();
  });

  it("offers Move, Discard, and Delete on every row", () => {
    render(<ProductStockedAt product={product} />);
    const menu = render(
      mocks.extraActions.current!(mocks.rows.current[0] as never),
    );
    expect(menu.getByText("Move to...")).toBeInTheDocument();
    expect(menu.getByText("Discard...")).toBeInTheDocument();
    expect(menu.getByText("Delete")).toBeInTheDocument();
  });

  it("names a deleted row by the page's product", () => {
    fireRowAction("Delete", 0);

    const props = mocks.deleteDialog.mock.calls.at(-1)?.[0];
    expect(props.open).toBe(true);
    expect(props.items).toHaveLength(1);
    expect(props.items[0].product.name).toBe("Bora Clamp");
    expect(props.items[0].id).toBe("INV-AAAA");
  });

  it("hands Move the row's own source location", () => {
    fireRowAction("Move to...", 1);

    const props = mocks.moveDialog.mock.calls.at(-1)?.[0];
    expect(props.open).toBe(true);
    expect(props.items[0].location.id).toBe("LOC-BBBB");
  });

  it("seeds Discard with the shelf whose row was clicked", () => {
    fireRowAction("Discard...", 1);

    const props = mocks.discardDialog.mock.calls.at(-1)?.[0];
    expect(props.open).toBe(true);
    expect(props.defaultInventoryEntryId).toBe("INV-BBBB");
  });

  it("leaves every dialog closed and unseeded at rest", () => {
    render(<ProductStockedAt product={product} />);

    expect(mocks.moveDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: false, items: [] }),
    );
    expect(mocks.deleteDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: false, items: [] }),
    );
    expect(mocks.discardDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: false,
        defaultInventoryEntryId: undefined,
      }),
    );
  });
});
