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
  moveDialog: vi.fn(),
  deleteDialog: vi.fn(),
  discardDialog: vi.fn(),
}));

vi.mock("~/lib/wasm", () => ({ wasm: {} }));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({ inventory: { update: { mutationOptions: vi.fn() } } }),
}));
vi.mock("~/app/_components/data-table/Table", () => ({
  default: (props: unknown) => {
    mocks.rTable(props);
    return <div data-testid="rtable" />;
  },
}));
// Render the row menu's items as plain buttons: Base UI's DropdownMenuItem
// needs a menu root, and this test drives the actions directly.
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
  }) => {
    mocks.extraActions.current = opts.extraActions ?? null;
    mocks.rows.current = opts.data;
    return {
      table: { getRowModel: () => ({ rows: [] }), resetRowSelection: vi.fn() },
      bulkActionBar: null,
      deleteDialog: null,
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
  location: { id: unsafeLocationShortcode(locationId), name: "shelf" },
});

const product = {
  id: unsafeProductShortcode("PRD-AAAA"),
  name: "Bora Clamp",
  unitMappings: [],
  inventoryEntry: [
    entry("INV-AAAA", "LOC-AAAA"),
    entry("INV-BBBB", "LOC-BBBB"),
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
  const menu = render(<>{mocks.extraActions.current!(row as never)}</>);
  fireEvent.click(menu.getByText(label));
};

beforeEach(() => {
  for (const m of [
    mocks.rTable,
    mocks.moveDialog,
    mocks.deleteDialog,
    mocks.discardDialog,
  ])
    m.mockClear();
  mocks.extraActions.current = null;
});

describe("ProductStockedAt", () => {
  it("keeps its own persisted-width scope, separate from the /inventory index", () => {
    render(<ProductStockedAt product={product} />);
    expect(mocks.rTable).toHaveBeenCalledWith(
      expect.objectContaining({ sizingKey: "inventory:product-detail" }),
    );
  });

  it("renders the empty shelf state instead of a table when nothing is stocked", () => {
    render(
      <ProductStockedAt
        product={{ ...product, inventoryEntry: [] } as ProductWithFoodOut}
      />,
    );
    expect(mocks.rTable).not.toHaveBeenCalled();
    expect(screen.getByText("Not stocked anywhere")).toBeInTheDocument();
  });

  it("offers Move, Discard, and Delete on every row", () => {
    render(<ProductStockedAt product={product} />);
    const menu = render(
      <>{mocks.extraActions.current!(mocks.rows.current[0] as never)}</>,
    );
    expect(menu.getByText("Move to...")).toBeInTheDocument();
    expect(menu.getByText("Discard...")).toBeInTheDocument();
    expect(menu.getByText("Delete")).toBeInTheDocument();
  });

  it("names a deleted row by the page's product", () => {
    // The shared dialogs label rows by `product.name`, but
    // `productWithFoodOut.inventoryEntry` carries no product embed — the page
    // grafts its own on rather than refetching a list-shaped row. Without
    // that, the confirm dialog reads "undefined - 2 each".
    fireRowAction("Delete", 0);

    const props = mocks.deleteDialog.mock.calls.at(-1)?.[0];
    expect(props.open).toBe(true);
    expect(props.items).toHaveLength(1);
    expect(props.items[0].product.name).toBe("Bora Clamp");
    expect(props.items[0].id).toBe("INV-AAAA");
  });

  it("hands Move the row's own source location", () => {
    // MoveInventoryDialog derives the source from items[0].location.id when no
    // sourceLocationId is passed; this page has no single source to pass.
    fireRowAction("Move to...", 1);

    const props = mocks.moveDialog.mock.calls.at(-1)?.[0];
    expect(props.open).toBe(true);
    expect(props.items[0].location.id).toBe("LOC-BBBB");
  });

  it("seeds Discard with the shelf whose row was clicked", () => {
    // The product sits on two shelves, so nothing may guess which one a
    // discard means — but a row click knows.
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
