import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTableColumnSizing } from "./useTableColumnSizing";

// The test environment doesn't provide localStorage — stub a minimal one.
beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

// The hook caches parsed stores in a module-level Map keyed by table, so each
// test uses a distinct key to avoid cross-test bleed, and clears storage.
describe("useTableColumnSizing", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("starts empty and persists a resized width per table", () => {
    const { result } = renderHook(() => useTableColumnSizing("recipe"));
    expect(result.current.columnSizing).toEqual({});
    expect(result.current.setColumnSize).toBeDefined();

    act(() => result.current.setColumnSize?.("name", 320));
    expect(result.current.columnSizing.name).toBe(320);
    expect(
      JSON.parse(localStorage.getItem("table-sizes:recipe") ?? "{}"),
    ).toEqual({ name: 320 });
  });

  it("clamps below the minimum and rounds fractional widths", () => {
    const { result } = renderHook(() => useTableColumnSizing("meal"));
    act(() => result.current.setColumnSize?.("name", 12));
    expect(result.current.columnSizing.name).toBe(48); // MIN_COLUMN_WIDTH
    act(() => result.current.setColumnSize?.("name", 200.7));
    expect(result.current.columnSizing.name).toBe(201);
  });

  it("resetColumnSize removes only that column", () => {
    const { result } = renderHook(() => useTableColumnSizing("cookbook"));
    act(() => {
      result.current.setColumnSize?.("name", 300);
      result.current.setColumnSize?.("createdAt", 120);
    });
    act(() => result.current.resetColumnSize?.("name"));
    expect(result.current.columnSizing).toEqual({ createdAt: 120 });
  });

  it("resetAllColumnSizes clears every stored width", () => {
    const { result } = renderHook(() => useTableColumnSizing("vendor"));
    act(() => {
      result.current.setColumnSize?.("name", 300);
      result.current.setColumnSize?.("createdAt", 120);
    });
    act(() => result.current.resetAllColumnSizes?.());
    expect(result.current.columnSizing).toEqual({});
  });

  it("hydrates from existing localStorage", () => {
    localStorage.setItem(
      "table-sizes:usda-food",
      JSON.stringify({ name: 260 }),
    );
    const { result } = renderHook(() => useTableColumnSizing("usda-food"));
    expect(result.current.columnSizing.name).toBe(260);
  });

  // Two tables over the same entity with different column sets must not share
  // widths — same reason useTableColumnVisibility takes a scope.
  it("scopes the store key so a second table over the same entity is separate", () => {
    const main = renderHook(() => useTableColumnSizing("task"));
    const embedded = renderHook(() => useTableColumnSizing("task", "embedded"));

    act(() => main.result.current.setColumnSize?.("name", 300));
    expect(main.result.current.columnSizing.name).toBe(300);
    expect(embedded.result.current.columnSizing.name).toBeUndefined();
    expect(localStorage.getItem("table-sizes:task:embedded")).toBeNull();

    act(() => embedded.result.current.setColumnSize?.("name", 180));
    expect(
      JSON.parse(localStorage.getItem("table-sizes:task:embedded") ?? "{}"),
    ).toEqual({ name: 180 });
    expect(main.result.current.columnSizing.name).toBe(300);
  });

  // How a table opts out of resizing: no key, no setters, so
  // `ColumnResizeHandle` renders nothing and the View menu hides its reset.
  it("is inert without a key", () => {
    const { result } = renderHook(() => useTableColumnSizing(undefined));
    expect(result.current.columnSizing).toEqual({});
    expect(result.current.setColumnSize).toBeUndefined();
    expect(result.current.resetColumnSize).toBeUndefined();
    expect(result.current.resetAllColumnSizes).toBeUndefined();
  });
});
