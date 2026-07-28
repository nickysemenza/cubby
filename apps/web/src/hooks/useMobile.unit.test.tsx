import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./useMobile";

/**
 * Installs a matchMedia whose result is controlled independently of
 * `window.innerWidth`, so the two can be made to disagree — which is the whole
 * point of these tests.
 */
function stubViewport({
  innerWidth,
  queryMatches,
}: {
  innerWidth: number;
  queryMatches: boolean;
}) {
  const listeners = new Set<() => void>();
  let matches = queryMatches;

  Object.defineProperty(window, "innerWidth", {
    value: innerWidth,
    configurable: true,
    writable: true,
  });

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    })),
  );

  return {
    /** Emit a media-query change, as a real resize would. */
    setMatches(next: boolean) {
      matches = next;
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
  it("follows the media query even when innerWidth disagrees", () => {
    // The regression: seeding from `window.innerWidth` while subscribing to
    // matchMedia meant the mount read won forever — the query already matched,
    // so no `change` event was ever emitted to correct it. Result: every CSS
    // breakpoint went mobile (compact nav) while the data table stayed on its
    // desktop layout and the mobile filter sheet was unreachable.
    stubViewport({ innerWidth: 1265, queryMatches: true });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("is false when the query does not match", () => {
    stubViewport({ innerWidth: 390, queryMatches: false });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("reacts to viewport changes", () => {
    const viewport = stubViewport({ innerWidth: 1440, queryMatches: false });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => viewport.setMatches(true));
    expect(result.current).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    const viewport = stubViewport({ innerWidth: 390, queryMatches: true });
    const { unmount } = renderHook(() => useIsMobile());
    expect(viewport.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });
});
