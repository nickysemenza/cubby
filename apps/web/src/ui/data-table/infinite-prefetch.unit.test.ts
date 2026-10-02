import { describe, expect, it } from "vitest";

import { shouldPrefetchNextPage } from "./infinite-prefetch";

const base = {
  lastRenderedIndex: 0,
  rowCount: 100,
  visibleRows: 20,
  hasNextPage: true,
  isFetchingNextPage: false,
  isTransitioning: false,
};

// Failures: waiting until the last row is on screen (a visible stall at every
// page boundary), double-fetching while a page is in flight, or fetching
// during a filter transition or after the last page.
describe("shouldPrefetchNextPage", () => {
  it("prefetches once the rendered range is within two panes of the end", () => {
    expect(shouldPrefetchNextPage({ ...base, lastRenderedIndex: 59 })).toBe(
      false,
    );
    expect(shouldPrefetchNextPage({ ...base, lastRenderedIndex: 60 })).toBe(
      true,
    );
  });

  it("keeps a floor of runway for short panes", () => {
    expect(
      shouldPrefetchNextPage({
        ...base,
        visibleRows: 2,
        lastRenderedIndex: 70,
      }),
    ).toBe(true);
  });

  it("waits while a page is in flight, during a transition, or at the end", () => {
    const near = { ...base, lastRenderedIndex: 99 };
    expect(shouldPrefetchNextPage({ ...near, isFetchingNextPage: true })).toBe(
      false,
    );
    expect(shouldPrefetchNextPage({ ...near, isTransitioning: true })).toBe(
      false,
    );
    expect(shouldPrefetchNextPage({ ...near, hasNextPage: false })).toBe(false);
  });

  it("does nothing before any rows exist", () => {
    expect(shouldPrefetchNextPage({ ...base, rowCount: 0 })).toBe(false);
  });
});
