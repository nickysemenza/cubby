import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHouseholdToday } from "./use-household-today";

afterEach(() => vi.useRealTimers());
describe("nutrition day rollover", () => {
  it("moves to the next household day at midnight after DST changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T06:59:59.000Z"));
    const { result, unmount } = renderHook(() =>
      useHouseholdToday("2026-03-08"),
    );
    expect(result.current).toBe("2026-03-08");
    act(() => vi.advanceTimersByTime(1200));
    expect(result.current).toBe("2026-03-09");
    unmount();
  });
  it("refreshes after waking on another day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T02:00:00Z"));
    const { result, unmount } = renderHook(() =>
      useHouseholdToday("2026-09-14"),
    );
    vi.setSystemTime(new Date("2026-09-16T08:00:00Z"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe("2026-09-16");
    unmount();
  });
});
