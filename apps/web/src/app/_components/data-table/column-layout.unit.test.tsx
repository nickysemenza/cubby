import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  type CubbyDefaultTableLayout,
  isTableLayoutCustomized,
  resolvedTableColumnWidths,
  tableSurplusColumnId,
  useRevealTableColumnsOnce,
  useTableColumnLayout,
  withLockedEndLast,
} from "./column-layout";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "./table-features";

interface Row {
  id: string;
  name: string;
  cost: number;
}

const helper = createCubbyColumnHelper<Row>();

const defaults: CubbyDefaultTableLayout = {
  columnOrder: ["name", "cost", "actions"],
  columnPinning: { start: [], end: ["actions"] },
  columnVisibility: { name: true, cost: true, actions: true },
  columnSizing: {},
};

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
  it("distinguishes an intentional customization from the computed default", () => {
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

  it("treats a sparse current visibility map as equal to a full default one", () => {
    // `current.columnVisibility` only ever records ids a person actually
    // toggled — an id absent from it still renders visible, the same as an
    // explicit `true` in `defaults`. A raw deep-equal would flag every
    // untouched table as "customized".
    expect(
      isTableLayoutCustomized({ ...defaults, columnVisibility: {} }, defaults),
    ).toBe(false);
  });

  it("flags any explicit resize as a customization", () => {
    expect(
      isTableLayoutCustomized(
        { ...defaults, columnSizing: { name: 300 } },
        defaults,
      ),
    ).toBe(true);
  });

  it("is never customized without a computed default", () => {
    expect(isTableLayoutCustomized(defaults, undefined)).toBe(false);
  });
});

describe("withLockedEndLast", () => {
  it("moves locked-end ids to the tail and leaves everything else in place", () => {
    const lockedEnd = new Set(["actions"]);
    expect(withLockedEndLast(["actions", "cost", "name"], lockedEnd)).toEqual([
      "cost",
      "name",
      "actions",
    ]);
    expect(withLockedEndLast(["cost", "name"], lockedEnd)).toEqual([
      "cost",
      "name",
    ]);
  });
});

describe("useTableColumnLayout", () => {
  it("fixes the structural image strip to its thumbnail width and pins it to the start", () => {
    const imageColumns = createCubbyColumnCollection<Row>((add) => {
      add(
        helper.display({
          id: "thumbnail",
          meta: {
            className: "h-px w-16 overflow-hidden px-0 py-0",
            entityColumnRole: "image",
          },
        }),
      );
      add(helper.accessor("name", { header: "Name" }));
    });

    const { result } = renderHook(() =>
      useTableColumnLayout({ columns: imageColumns }),
    );

    expect(result.current.columns[0]).toMatchObject({
      size: 64,
      minSize: 64,
      maxSize: 64,
      enableResizing: false,
    });
    expect(result.current.defaultLayout.columnOrder[0]).toBe("thumbnail");
    expect(result.current.defaultLayout.columnPinning.start).toEqual([
      "thumbnail",
    ]);
  });

  it("imports legacy Tailwind widths into v9 numeric column definitions", () => {
    const legacyColumns = createCubbyColumnCollection<Row>((add) => {
      add(
        helper.accessor("name", {
          header: "Name",
          meta: { className: "w-64 min-w-40 max-w-96 truncate" },
        }),
      );
    });
    const { result } = renderHook(() =>
      useTableColumnLayout({ columns: legacyColumns }),
    );

    expect(result.current.columns[0]).toMatchObject({
      size: 256,
      minSize: 160,
      maxSize: 384,
    });
  });

  it("keeps Actions pinned end and honors initial visibility overrides", () => {
    const withActions = createCubbyColumnCollection<Row>((add) => {
      add(helper.accessor("name", { header: "Name" }));
      add(helper.accessor("cost", { header: "Cost" }));
      add(
        helper.display({
          id: "rowMenu",
          header: "",
          meta: { entityColumnRole: "action" },
        }),
      );
    });
    const { result } = renderHook(() =>
      useTableColumnLayout({
        columns: withActions,
        initialColumnVisibility: { cost: false },
      }),
    );

    expect(result.current.defaultLayout).toEqual({
      columnOrder: ["name", "cost", "rowMenu"],
      columnPinning: { start: [], end: ["rowMenu"] },
      columnVisibility: { name: true, cost: false, rowMenu: true },
      columnSizing: {},
    });
  });
});

describe("useRevealTableColumnsOnce", () => {
  it("reveals a hidden worklist column once per key", () => {
    const { result } = renderHook(() => {
      const [columnVisibility, setColumnVisibility] = useState<
        Record<string, boolean>
      >({ name: true, cost: false });
      useRevealTableColumnsOnce(setColumnVisibility, {
        key: "productsMissingPrice",
        visibility: { cost: true },
      });
      return columnVisibility;
    });

    expect(result.current.cost).toBe(true);
  });

  it("does not re-apply the same key after a later manual toggle", () => {
    const { result, rerender } = renderHook(
      ({ worklist }: { worklist?: string }) => {
        const [columnVisibility, setColumnVisibility] = useState<
          Record<string, boolean>
        >({ name: true, cost: false });
        useRevealTableColumnsOnce(
          setColumnVisibility,
          worklist ? { key: worklist, visibility: { cost: true } } : undefined,
        );
        return { columnVisibility, setColumnVisibility };
      },
      { initialProps: { worklist: "productsMissingPrice" } },
    );

    act(() => result.current.setColumnVisibility({ name: true, cost: false }));
    rerender({ worklist: "productsMissingPrice" });
    expect(result.current.columnVisibility.cost).toBe(false);
  });

  it("reveals a newly activated worklist without a route remount", () => {
    const { result, rerender } = renderHook<
      Record<string, boolean>,
      { worklist?: string }
    >(
      ({ worklist }) => {
        const [columnVisibility, setColumnVisibility] = useState<
          Record<string, boolean>
        >({ name: true, cost: false });
        useRevealTableColumnsOnce(
          setColumnVisibility,
          worklist ? { key: worklist, visibility: { cost: true } } : undefined,
        );
        return columnVisibility;
      },
      { initialProps: {} },
    );

    expect(result.current.cost).toBe(false);
    rerender({ worklist: "productsMissingPrice" });
    expect(result.current.cost).toBe(true);
  });
});
