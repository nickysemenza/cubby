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

// The hook caches parsed stores in a module-level Map keyed by entity, so each
// test uses a distinct entity to avoid cross-test bleed, and clears storage.
describe("useTableColumnSizing", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("starts empty and persists a resized width per entity", () => {
    const { result } = renderHook(() => useTableColumnSizing("recipe"));
    expect(result.current.columnSizing).toEqual({});

    act(() => result.current.setColumnSize("name", 320));
    expect(result.current.columnSizing.name).toBe(320);
    expect(
      JSON.parse(localStorage.getItem("table-sizes:recipe") ?? "{}"),
    ).toEqual({ name: 320 });
  });

  it("clamps below the minimum and rounds fractional widths", () => {
    const { result } = renderHook(() => useTableColumnSizing("meal"));
    act(() => result.current.setColumnSize("name", 12));
    expect(result.current.columnSizing.name).toBe(48); // MIN_COLUMN_WIDTH
    act(() => result.current.setColumnSize("name", 200.7));
    expect(result.current.columnSizing.name).toBe(201);
  });

  it("resetColumnSize removes only that column", () => {
    const { result } = renderHook(() => useTableColumnSizing("cookbook"));
    act(() => {
      result.current.setColumnSize("name", 300);
      result.current.setColumnSize("createdAt", 120);
    });
    act(() => result.current.resetColumnSize("name"));
    expect(result.current.columnSizing).toEqual({ createdAt: 120 });
  });

  it("hydrates from existing localStorage", () => {
    localStorage.setItem(
      "table-sizes:usda-food",
      JSON.stringify({ name: 260 }),
    );
    const { result } = renderHook(() => useTableColumnSizing("usda-food"));
    expect(result.current.columnSizing.name).toBe(260);
  });
});
