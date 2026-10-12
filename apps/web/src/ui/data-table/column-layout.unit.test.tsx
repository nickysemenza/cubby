import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { dateCellData, selectCellData, timestampCellData } from "./cell-data";
import {
  type CubbyDefaultTableLayout,
  isTableLayoutCustomized,
  columnRailWidth,
  resolvedTableColumnWidths,
  useRevealTableColumnsOnce,
  useTableColumnLayout,
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
  const name = column("name", 240, {
    maxSize: 480,
    meta: { entityColumnRole: "identity" },
  });
  const parent = column("parent", 176, { maxSize: 352 });
  const cost = column("cost", 104, { maxSize: 208, meta: { numeric: true } });
  const status = column("status", 136, {
    maxSize: 272,
    meta: { cellData: { kind: "select" } },
  });
  const code = column("orderId", 160, { maxSize: 320, meta: { mono: true } });
  const actions = column("actions", 40, {
    pinned: "end",
    meta: { entityColumnRole: "action" },
  });

  // Regressions: all slack went to one column past its maxSize, so a
  // three-column list painted a 1200px name beside crammed facts; even
  // spreading then widened every text column while the title stayed clipped.
  // A name wider than 240px then pushed every fact off the pane, so the
  // identity fits to 240px and clipped names spill over on hover instead.
  it.each<{
    case: string;
    columns: WidthColumn[];
    available: number;
    userSized: string[];
    measured: Record<string, number>;
    widths: Record<string, number>;
    spacer: number;
  }>([
    {
      case: "grows a short identity to its 240px fit before its peers",
      columns: [name, parent, cost, actions],
      available: 800,
      userSized: [],
      measured: { name: 180 },
      // 300px slack: name takes 60px up to its fit, parent its 176px of room.
      widths: { name: 240, parent: 352, cost: 104, actions: 40 },
      spacer: 64,
    },
    {
      case: "splits slack across the identity's peers by configured width",
      columns: [name, parent, column("notes", 88, { maxSize: 1000 })],
      available: 1080,
      userSized: ["name"],
      measured: {},
      // 576px slack in a 176:88 ratio; parent caps at 352, notes takes the rest.
      widths: { name: 240, parent: 352, notes: 488 },
      spacer: 0,
    },
    {
      case: "caps each column at its fit and leaves the rest to the spacer",
      columns: [name, parent, status, actions],
      available: 2000,
      userSized: [],
      measured: { name: 900 },
      widths: { name: 240, parent: 352, status: 136, actions: 40 },
      spacer: 2000 - (240 + 352 + 136 + 40),
    },
    {
      case: "fits a code column to 128px however long its values are",
      columns: [code],
      available: 400,
      userSized: [],
      measured: { orderId: 190 },
      widths: { orderId: 128 },
      spacer: 272,
    },
    {
      case: "never refits a column a person sized",
      columns: [
        column("name", 420, { maxSize: 480, meta: name.columnDef.meta }),
        parent,
        actions,
      ],
      available: 1000,
      userSized: ["name"],
      measured: { name: 180 },
      widths: { name: 420, parent: 352, actions: 40 },
      spacer: 1000 - (420 + 352 + 40),
    },
    {
      case: "keeps configured widths when the pane is narrower",
      columns: [name, cost, actions],
      available: 300,
      userSized: [],
      measured: {},
      widths: { name: 240, cost: 104, actions: 40 },
      spacer: 0,
    },
    {
      case: "gives a pinned measurement column nothing",
      columns: [column("verifiedAt", 128, { pinned: "end" })],
      available: 400,
      userSized: [],
      measured: {},
      widths: { verifiedAt: 128 },
      spacer: 272,
    },
  ])("$case", ({ columns, available, userSized, measured, widths, spacer }) => {
    const resolved = resolvedTableColumnWidths(
      columns,
      available,
      new Set(userSized),
      measured,
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
    { meta: {}, size: 160 },
    { meta: { numeric: true }, size: 72 },
    { meta: { cellData: dateCellData(() => null) }, size: 96 },
    { meta: { cellData: timestampCellData(() => null) }, size: 72 },
    {
      meta: {
        numeric: true,
        explanation: { entity: "product", field: "price", label: "Price" },
      },
      size: 72 + 18,
    },
    { meta: { className: "w-20", suggest: true }, size: 80 + 18 },
  ])("sizes column $# to $size", ({ meta, size }) => {
    const columns = createCubbyColumnCollection<Row>((add) => {
      add(helper.accessor("cost", { header: "Cost", meta }));
    });
    const { result } = renderHook(() => useTableColumnLayout({ columns }));
    expect(result.current.columns[0]).toMatchObject({ size });
  });

  // Headers wrap to two lines, so a label needs only its longest word or
  // about half its length: "Itemization coverage" no longer widens its pill
  // column to 154px, and a long header still stops at a fixed cap.
  it.each([
    { header: "Kind", size: 104 },
    { header: "Itemization coverage", size: 104 },
    { header: "Refrigeration requirements", size: Math.ceil(15 * 6.5) + 24 },
    { header: "A very long header that would otherwise dominate", size: 160 },
  ])("fits the $header header", ({ header, size }) => {
    const columns = createCubbyColumnCollection<Row>((add) => {
      add(
        helper.accessor("cost", {
          header,
          meta: { cellData: selectCellData(() => null, []) },
        }),
      );
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
    ).toBe(36);
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
