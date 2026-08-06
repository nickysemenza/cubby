import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rTable: vi.fn(),
  discardDialog: vi.fn(),
}));

vi.mock("~/lib/wasm", () => ({ wasm: {} }));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    inventory: {
      list: { queryOptions: vi.fn() },
      update: { mutationOptions: vi.fn() },
    },
  }),
}));
vi.mock("../data-table/Table", () => ({
  default: (props: unknown) => {
    mocks.rTable(props);
    return <div />;
  },
}));
vi.mock("../hooks/useEntityList", () => ({
  useEntityList: () => ({
    table: { getRowModel: () => ({ rows: [] }) },
    data: [],
    isLoading: false,
    error: null,
    bulkActionBar: null,
  }),
}));
vi.mock("../hooks/useUpdateMutation", () => ({
  useUpdateMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../products/product-image-summaries", () => ({
  ProductImageSummariesProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useHydratedProductImages: () => ({}),
}));
vi.mock("../products/product-unit-mapping-summaries", () => ({
  useProductUnitMappingSummaries: () => ({}),
}));
vi.mock("../inventory/delete-inventory-dialog", () => ({
  DeleteInventoryDialog: () => null,
}));
vi.mock("../inventory/move-inventory-dialog", () => ({
  MoveInventoryDialog: () => null,
}));
vi.mock("../inventory/inventory-discard-dialog", () => ({
  InventoryDiscardDialog: (props: unknown) => {
    mocks.discardDialog(props);
    return null;
  },
}));

import { LocationInventoryTable } from "./location-inventory-table";

describe("LocationInventoryTable", () => {
  it("uses an independent persisted-width scope from the inventory index", () => {
    render(
      <LocationInventoryTable
        locationId={unsafeLocationShortcode("LOC-TEST")}
        view="table"
      />,
    );

    expect(mocks.rTable).toHaveBeenCalledWith(
      expect.objectContaining({ sizingKey: "inventory:location-detail" }),
    );
  });

  it("does not mount the discard dialog until a row targets one", () => {
    // `InventoryDiscardDialog` fetches the row's product so the operator sees
    // every shelf it sits on, not just this location's. Mounting it at rest
    // would fire that query on every render of the table.
    render(
      <LocationInventoryTable
        locationId={unsafeLocationShortcode("LOC-TEST")}
        view="table"
      />,
    );

    expect(mocks.discardDialog).not.toHaveBeenCalled();
  });
});
