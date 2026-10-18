import { render } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it, vi } from "vitest";

import type { InfiniteScrollControls } from "~/entity/hooks/use-infinite-table-list";

import { useInfiniteScrollSentinel } from "./use-infinite-scroll-sentinel";

function Sentinel() {
  const ref = useInfiniteScrollSentinel(
    fromPartial<InfiniteScrollControls>({
      fetchNextPage: vi.fn(),
      hasNextPage: true,
      isFetchingNextPage: false,
      isTransitioning: false,
    }),
    "200px",
  );
  return <div ref={ref} />;
}

// Regression: a list that re-rendered after its test unstubbed the global threw
// an uncaught ReferenceError from this effect, failing whichever test ran next.
it("mounts without an IntersectionObserver implementation", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  expect(() => render(<Sentinel />)).not.toThrow();
});
