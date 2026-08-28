import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { densityConfig, useTableDensity } from "./useTableDensity";

afterEach(() => {
  localStorage.removeItem("table-density");
});

describe("useTableDensity", () => {
  it("keeps the shared default at the 32px compact contract", () => {
    const { result } = renderHook(() => useTableDensity());

    expect(result.current.density).toBe("compact");
    expect(densityConfig[result.current.density].rowHeight).toBe(32);
  });

  it("lets a read-heavy surface opt into the 28px dense contract", () => {
    const { result } = renderHook(() => useTableDensity("dense"));

    expect(result.current.density).toBe("dense");
    expect(densityConfig[result.current.density].rowHeight).toBe(28);
    expect(densityConfig[result.current.density].rowClass).toBe("h-7");
  });

  it("keeps an explicit density choice for subsequent table visits", () => {
    const { result } = renderHook(() => useTableDensity());

    act(() => result.current.setDensity("comfortable"));

    expect(result.current.density).toBe("comfortable");
    expect(localStorage.getItem("table-density")).toBe("comfortable");
  });
});
