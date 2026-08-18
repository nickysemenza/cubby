import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createCubbyColumnHelper } from "./table-features";
import {
  type CubbyTableLayoutV1,
  clearTableLayoutStoresForTests,
  normalizeTableLayout,
  useCubbyTableLayout,
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
});

describe("useCubbyTableLayout", () => {
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
});
