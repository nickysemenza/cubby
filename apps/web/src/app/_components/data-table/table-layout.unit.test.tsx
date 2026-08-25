import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createCubbyColumnHelper } from "./table-features";
import {
  type CubbyTableLayoutV1,
  clearTableLayoutStoresForTests,
  isTableLayoutCustomized,
  normalizeTableLayout,
  resolvedTableColumnWidths,
  tableSurplusColumnId,
  useCubbyTableLayout,
  useRevealTableColumnsOnce,
  withLockedEndLast,
} from "./table-layout";

interface Row {
  id: string;
  name: string;
  cost: number;
}

const helper = createCubbyColumnHelper<Row>();
const columns = helper.columns([
  helper.accessor("name", {
    header: "Name",
    minSize: 100,
    maxSize: 300,
  }),
  helper.accessor("cost", { header: "Cost" }),
]);

const defaults: CubbyTableLayoutV1 = {
  version: 1,
  columnOrder: ["name", "cost", "actions"],
  columnPinning: { start: [], end: [] },
  columnVisibility: { name: true, cost: true, actions: true },
  columnSizing: {},
};

beforeEach(() => {
  localStorage.clear();
  clearTableLayoutStoresForTests();
});

describe("normalizeTableLayout", () => {
  it("drops stale and duplicate ids, appends new columns, and resolves duplicate pins to start", () => {
    expect(
      normalizeTableLayout(
        {
          columnOrder: ["cost", "stale", "cost"],
          columnPinning: {
            start: ["name", "name"],
            end: ["name", "actions", "stale"],
          },
          columnVisibility: { cost: false, stale: false },
          columnSizing: { cost: 10, stale: 999 },
        },
        defaults,
      ),
    ).toEqual({
      version: 1,
      columnOrder: ["cost", "name", "actions"],
      columnPinning: { start: ["name"], end: ["actions"] },
      columnVisibility: { name: true, cost: false, actions: true },
      columnSizing: { cost: 48 },
    });
  });

  it("keeps Select and Image first, visible, and pinned to the start", () => {
    const structuralDefaults: CubbyTableLayoutV1 = {
      version: 1,
      columnOrder: ["select", "image", "name", "cost"],
      columnPinning: { start: [], end: [] },
      columnVisibility: {
        select: true,
        image: true,
        name: true,
        cost: true,
      },
      columnSizing: {},
    };

    expect(
      normalizeTableLayout(
        {
          columnOrder: ["cost", "image", "name", "select"],
          columnPinning: {
            start: ["cost"],
            end: ["image", "select", "name"],
          },
          columnVisibility: { select: false, image: false },
        },
        structuralDefaults,
      ),
    ).toMatchObject({
      columnOrder: ["select", "image", "cost", "name"],
      columnPinning: {
        start: ["select", "image", "cost"],
        end: ["name"],
      },
      columnVisibility: { select: true, image: true },
    });
  });

  // Regression: `actions` used to be an ordinary draggable center column, so a
  // single drag — or the stale localStorage layout it persisted — stranded the
  // row-actions menu mid-table on every later visit.
  it("drags a persisted mid-table Actions column back to the trailing edge", () => {
    expect(
      normalizeTableLayout(
        {
          columnOrder: ["actions", "name", "cost"],
          columnPinning: { start: ["actions"], end: [] },
          columnVisibility: { actions: false },
        },
        defaults,
      ),
    ).toMatchObject({
      columnOrder: ["name", "cost", "actions"],
      columnPinning: { start: [], end: ["actions"] },
      columnVisibility: { actions: true },
    });
  });

  it("keeps Actions behind a column the user pinned to the end themselves", () => {
    expect(
      normalizeTableLayout(
        { columnPinning: { start: [], end: ["actions", "cost"] } },
        defaults,
      ).columnPinning,
    ).toEqual({ start: [], end: ["cost", "actions"] });
  });

  it("omits locked-end pinning for a table with no Actions column", () => {
    expect(
      normalizeTableLayout(undefined, {
        version: 1,
        columnOrder: ["name", "cost"],
        columnPinning: { start: [], end: [] },
        columnVisibility: { name: true, cost: true },
        columnSizing: {},
      }).columnPinning,
    ).toEqual({ start: [], end: [] });
  });
});

describe("desktop surplus allocation", () => {
  const widthColumns = [
    {
      id: "name",
      getSize: () => 256,
      getIsPinned: () => false as const,
      columnDef: { header: "Name", meta: { surplus: true } },
    },
    {
      id: "cost",
      getSize: () => 128,
      getIsPinned: () => false as const,
      columnDef: { header: "Cost", meta: { numeric: true } },
    },
    {
      id: "actions",
      getSize: () => 40,
      getIsPinned: () => "end" as const,
      columnDef: { header: "" },
    },
  ];

  it("gives spare desktop width to the nominated record-identity column", () => {
    expect(tableSurplusColumnId(widthColumns)).toBe("name");
    expect(resolvedTableColumnWidths(widthColumns, 900)).toEqual({
      name: 732,
      cost: 128,
      actions: 40,
    });
  });

  it("keeps configured widths and horizontal scrolling when the table is dense", () => {
    expect(resolvedTableColumnWidths(widthColumns, 300)).toEqual({
      name: 256,
      cost: 128,
      actions: 40,
    });
  });

  it("falls back to a readable conventional column for hand-authored tables", () => {
    expect(
      tableSurplusColumnId([
        {
          id: "select",
          getSize: () => 40,
          getIsPinned: () => "start" as const,
          columnDef: { header: "Select" },
        },
        {
          id: "product",
          getSize: () => 256,
          getIsPinned: () => false as const,
          columnDef: { header: "Product" },
        },
      ]),
    ).toBe("product");
  });

  it("never gives viewport surplus to a pinned measurement column", () => {
    expect(
      tableSurplusColumnId([
        {
          id: "verifiedAt",
          getSize: () => 128,
          getIsPinned: () => "end" as const,
          columnDef: { header: "Verified" },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("isTableLayoutCustomized", () => {
  it("distinguishes an intentional customization from the source default", () => {
    expect(isTableLayoutCustomized(defaults, defaults)).toBe(false);
    expect(
      isTableLayoutCustomized(
        {
          ...defaults,
          columnVisibility: { ...defaults.columnVisibility, cost: false },
        },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("withLockedEndLast", () => {
  it("moves locked-end ids to the tail and leaves everything else in place", () => {
    expect(withLockedEndLast(["actions", "cost", "name"])).toEqual([
      "cost",
      "name",
      "actions",
    ]);
    expect(withLockedEndLast(["cost", "name"])).toEqual(["cost", "name"]);
  });
});

describe("useCubbyTableLayout", () => {
  it("fixes the structural image strip to its thumbnail width", () => {
    localStorage.setItem(
      "table-layout:v1:products",
      JSON.stringify({
        version: 1,
        columnOrder: ["image", "name"],
        columnPinning: { start: ["image"], end: [] },
        columnVisibility: { image: true, name: true },
        columnSizing: { image: 128 },
      }),
    );
    const imageColumns = helper.columns([
      helper.display({
        id: "image",
        meta: { className: "h-px w-16 overflow-hidden px-0 py-0" },
      }),
      helper.accessor("name", { header: "Name" }),
    ]);

    const { result } = renderHook(() =>
      useCubbyTableLayout({ key: "products", columns: imageColumns }),
    );

    expect(result.current.columns[0]).toMatchObject({
      size: 64,
      minSize: 64,
      maxSize: 64,
      enableResizing: false,
    });
    expect(result.current.atoms.columnSizing.get().image).toBe(64);
  });

  it("imports legacy Tailwind widths into v9 numeric column definitions", () => {
    const legacyColumns = helper.columns([
      helper.accessor("name", {
        header: "Name",
        meta: { className: "w-64 min-w-40 max-w-96 truncate" },
      }),
    ]);
    const { result } = renderHook(() =>
      useCubbyTableLayout({ columns: legacyColumns }),
    );

    expect(result.current.columns[0]).toMatchObject({
      size: 256,
      minSize: 160,
      maxSize: 384,
    });
  });

  it("imports legacy visibility and sizing once, then writes only the v1 key", () => {
    localStorage.setItem("table-columns:expense:embedded", '{"cost":false}');
    localStorage.setItem("table-sizes:expense:embedded", '{"name":240}');

    const { result } = renderHook(() =>
      useCubbyTableLayout({
        key: "expense:embedded",
        columns,
        legacyVisibilityKey: "expense:embedded",
        legacySizingKey: "expense:embedded",
      }),
    );

    expect(result.current.atoms.columnVisibility.get().cost).toBe(false);
    expect(result.current.atoms.columnSizing.get()).toEqual({ name: 240 });
    expect(
      localStorage.getItem("table-layout:v1:expense:embedded"),
    ).not.toBeNull();
    expect(
      localStorage.getItem("table-columns:expense:embedded"),
    ).not.toBeNull();
    expect(localStorage.getItem("table-sizes:expense:embedded")).not.toBeNull();
  });

  it("keeps scoped keys independent", () => {
    const main = renderHook(() =>
      useCubbyTableLayout({ key: "task", columns }),
    );
    const embedded = renderHook(() =>
      useCubbyTableLayout({ key: "task:embedded", columns }),
    );

    act(() => main.result.current.atoms.columnVisibility.set({ cost: false }));

    expect(main.result.current.atoms.columnVisibility.get().cost).toBe(false);
    expect(embedded.result.current.atoms.columnVisibility.get().cost).toBe(
      true,
    );
    expect(localStorage.getItem("table-layout:v1:task")).toContain(
      '"cost":false',
    );
    expect(localStorage.getItem("table-layout:v1:task:embedded")).toContain(
      '"cost":true',
    );
  });

  it("applies an exact saved layout, clamps sizes to column bounds, and resets", () => {
    const { result } = renderHook(() =>
      useCubbyTableLayout({ key: "expense", columns }),
    );

    act(() =>
      result.current.applySavedLayout({
        columnOrder: ["cost", "name"],
        columnPinning: { start: ["cost"], end: ["name"] },
        columnVisibility: { name: false },
        columnSizing: { name: 900, cost: 12 },
      }),
    );

    expect(result.current.atoms.columnOrder.get()).toEqual(["cost", "name"]);
    expect(result.current.atoms.columnPinning.get()).toEqual({
      start: ["cost"],
      end: ["name"],
    });
    expect(result.current.atoms.columnVisibility.get()).toEqual({
      name: false,
      cost: true,
    });
    expect(result.current.atoms.columnSizing.get()).toEqual({
      name: 300,
      cost: 48,
    });

    act(() => result.current.reset());
    expect(result.current.atoms.columnOrder.get()).toEqual(["name", "cost"]);
    expect(result.current.atoms.columnPinning.get()).toEqual({
      start: [],
      end: [],
    });
  });

  it("reveals a persisted hidden worklist column once", () => {
    localStorage.setItem(
      "table-layout:v1:product",
      JSON.stringify({
        version: 1,
        columnOrder: ["name", "cost"],
        columnPinning: { start: [], end: [] },
        columnVisibility: { name: true, cost: false },
        columnSizing: {},
      }),
    );
    const { result } = renderHook(() => {
      const layout = useCubbyTableLayout({ key: "product", columns });
      useRevealTableColumnsOnce(layout, {
        key: "productsMissingPrice",
        visibility: { cost: true },
      });
      return layout;
    });

    expect(result.current.atoms.columnVisibility.get().cost).toBe(true);
    act(() =>
      result.current.atoms.columnVisibility.set({ name: true, cost: false }),
    );
    expect(result.current.atoms.columnVisibility.get().cost).toBe(false);
  });

  it("reveals a newly activated worklist without a route remount", () => {
    const { result, rerender } = renderHook(
      ({ worklist }: { worklist?: string }) => {
        const layout = useCubbyTableLayout({ key: "product", columns });
        useRevealTableColumnsOnce(
          layout,
          worklist ? { key: worklist, visibility: { cost: true } } : undefined,
        );
        return layout;
      },
      { initialProps: { worklist: undefined as string | undefined } },
    );

    act(() =>
      result.current.atoms.columnVisibility.set({ name: true, cost: false }),
    );
    rerender({ worklist: "productsMissingPrice" });
    expect(result.current.atoms.columnVisibility.get().cost).toBe(true);
  });
});
