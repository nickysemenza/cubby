import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { ListReadGroup } from "./progressive-list";
import type { ListQueryPlan, ListQueryResponse } from "./usePaginatedTableCore";
import { useProgressiveList } from "./useProgressiveList";

const abortable = <T,>(signal: AbortSignal, value: T) =>
  new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    setTimeout(() => resolve(value), 0);
  });

const pages: ListQueryResponse<{ id: string }>[] = [
  {
    items: [{ id: "first" }, { id: "second" }],
    deferredGroups: [{ id: "derived", fields: ["count"] }],
    meta: { pageIndex: 0, pageSize: 100, totalCount: 2 },
  },
];
const plan: ListQueryPlan<{ id: string }> = {
  queryKey: ["synthetic-list"],
  execute: async () => pages[0]!,
  progressive: {
    enrich: (ids, groups: ListReadGroup[], signal) =>
      abortable(signal, {
        groups: groups.map((id) => ({
          id,
          state: "ready" as const,
          data: ids.map((row) => ({ id: row, count: 1 })),
        })),
        missingIds: [],
      }),
    summary: (signal) => abortable(signal, { count: 2 }),
  },
};

describe("useProgressiveList", () => {
  // Regression: StrictMode's dev effect replay disposed the still-mounted
  // session, aborting the first enrichment while its rows were `loading`; the
  // replayed effect skipped them as in flight and they never resolved.
  it("resolves deferred cells and the summary after a StrictMode effect replay", async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useProgressiveList({
          pages,
          scope: "synthetic",
          queryKey: plan.queryKey,
          plan,
          paused: false,
          refreshing: false,
        }),
      { wrapper, reactStrictMode: true },
    );
    await waitFor(() => {
      expect(result.current.enrichmentState("first", "count")?.state).toBe(
        "ready",
      );
      expect(result.current.summaryState.state).toBe("ready");
    });
    expect(result.current.data).toEqual([
      { id: "first", count: 1 },
      { id: "second", count: 1 },
    ]);
  });
});
