import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { dateCellData } from "./cell-data";
import {
  type CubbyDefaultTableLayout,
  isTableLayoutCustomized,
  columnRailWidth,
  resolvedTableColumnWidths,
  useRevealTableColumnsOnce,
  useTableColumnLayout,
  withLockedEndLast,
} from "./column-layout";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "./table-features";
import type { CubbyColumnMeta } from "./table-meta";

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
  type WidthColumn = Parameters<typeof resolvedTableColumnWidths>[0][number];
  const column = (
    id: string,
    size: number,
    extra: {
      pinned?: "start" | "end";
      maxSize?: number;
      meta?: WidthColumn["columnDef"]["meta"];
    } = {},
  ): WidthColumn => ({
    id,
    getSize: () => size,
    getIsPinned: () => extra.pinned ?? false,
    columnDef: { header: id, maxSize: extra.maxSize, meta: extra.meta },
  });
  const name = column("name", 256, {
    maxSize: 512,
    meta: { entityColumnRole: "identity" },
  });
  const parent = column("parent", 176, { maxSize: 352 });
  const cost = column("cost", 104, { maxSize: 208, meta: { numeric: true } });
  const status = column("status", 136, {
    maxSize: 272,
    meta: { cellData: { kind: "select" } },
  });
  const actions = column("actions", 40, {
    pinned: "end",
    meta: { entityColumnRole: "action" },
  });

  // Regression: all slack went to one column past its maxSize, so a
  // three-column list painted a 1200px name beside crammed facts.
  it.each([
    {
      case: "splits slack across flexible columns by configured width",
      columns: [name, parent, cost, actions],
      available: 900,
      userSized: [],
      // 324px slack in a 256:176 ratio → +192 / +132.
      widths: { name: 448, parent: 308, cost: 104, actions: 40 },
      spacer: 0,
    },
    {
      case: "caps each column at maxSize and leaves the rest to the spacer",
      columns: [name, parent, status, actions],
      available: 2000,
      userSized: [],
      widths: { name: 512, parent: 352, status: 136, actions: 40 },
      spacer: 2000 - (512 + 352 + 136 + 40),
    },
    {
      case: "never widens a column a person sized",
      columns: [name, parent, actions],
      available: 1000,
      userSized: ["name"],
      widths: { name: 256, parent: 352, actions: 40 },
      spacer: 1000 - (256 + 352 + 40),
    },
    {
      case: "keeps configured widths when the pane is narrower",
      columns: [name, cost, actions],
      available: 300,
      userSized: [],
      widths: { name: 256, cost: 104, actions: 40 },
      spacer: 0,
    },
    {
      case: "gives a pinned measurement column nothing",
      columns: [column("verifiedAt", 128, { pinned: "end" })],
      available: 400,
      userSized: [],
      widths: { verifiedAt: 128 },
      spacer: 272,
    },
  ])("$case", ({ columns, available, userSized, widths, spacer }) => {
    const resolved = resolvedTableColumnWidths(
      columns,
      available,
      new Set(userSized),
    );
    expect(resolved.widths).toEqual(widths);
    expect(resolved.spacer).toBe(spacer);
  });
});

describe("column sizing defaults", () => {
  // A decorated column reserves its rail so the ⓘ can never paint over the
  // value ("$2.ⓘ99"); an undeclared column sizes by what it holds instead of
  // TanStack's blind 150px.
  it.each<{ meta: CubbyColumnMeta; size: number }>([
    { meta: {}, size: 176 },
    { meta: { numeric: true }, size: 104 },
    { meta: { cellData: dateCellData(() => null) }, size: 120 },
    {
      meta: {
        numeric: true,
        explanation: { entity: "product", field: "price", label: "Price" },
      },
      size: 104 + 22,
    },
    { meta: { className: "w-20", suggest: true }, size: 80 + 22 },
  ])("sizes column $# to $size", ({ meta, size }) => {
    const columns = createCubbyColumnCollection<Row>((add) => {
      add(helper.accessor("cost", { header: "Cost", meta }));
    });
    const { result } = renderHook(() => useTableColumnLayout({ columns }));
    expect(result.current.columns[0]).toMatchObject({ size });
  });

  it("reserves one rail slot per always-visible affordance", () => {
    expect(columnRailWidth(undefined)).toBe(0);
    expect(
      columnRailWidth({
        suggest: true,
        explanation: { entity: "product", field: "price", label: "Price" },
      }),
    ).toBe(44);
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
