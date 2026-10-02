import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { entityListBaseFor } from "~/entity/entity-list";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

import type { TableStateReturn } from "../data-table/useTableState";
import { useInfiniteTableList } from "./useInfiniteTableList";
import type { ListQueryResponse } from "./usePaginatedTableCore";

interface TestRow {
  id: string;
}

interface TestFilters {
  scope: string;
}

const tableState = fromPartial<TableStateReturn>({
  pagination: { pageIndex: 0, pageSize: 1 },
  getSorts: () => [{ orderBy: "name", direction: "asc" as const }],
});

const page = (
  id: string,
  pageIndex: number,
  totalCount: number,
): ListQueryResponse<TestRow> => ({
  items: [{ id }],
  meta: { pageIndex, pageSize: 1, totalCount },
});

const clients: QueryClient[] = [];
const createWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
};

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe("useInfiniteTableList", () => {
  it("invalidates the generated base catalog plan after an entity mutation", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const execute = vi.fn(async () => page("first", 0, 1));
    const basePlan = entityListBaseFor("expense").listQueryPlan({
      pagination: { pageIndex: 0, pageSize: 1 },
      filters: {},
    });
    const queryOptions = () => ({
      ...basePlan,
      execute,
      progressive: undefined,
    });
    renderHook(
      () =>
        useInfiniteTableList({
          queryOptions,
          buildFilters: () => ({}),
          tableState,
        }),
      { wrapper },
    );
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await invalidateOperationTags(client, entityRipple("expense"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  // A mutation can refetch identical core data before React observes fetching.
  // The prior derived request must retire at invalidation, not at base arrival.
  it("retires pending enrichment immediately when a mutation refetch structurally shares base rows", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const old = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; cost: number }[];
      }[];
      missingIds: string[];
    }>();
    const signals: AbortSignal[] = [];
    const response = {
      ...page("first", 0, 1),
      deferredGroups: [{ id: "derived" as const, fields: ["cost"] }],
    };
    const basePlan = entityListBaseFor("expense").listQueryPlan({
      pagination: { pageIndex: 0, pageSize: 1 },
      filters: {},
    });
    const execute = vi.fn(async () => response);
    const queryOptions = () => ({
      ...basePlan,
      execute,
      progressive: {
        enrich: async (
          _ids: string[],
          _groups: ("media" | "quality" | "relations" | "derived")[],
          signal: AbortSignal,
        ) => {
          signals.push(signal);
          return signals.length === 1
            ? old.promise
            : {
                groups: [
                  {
                    id: "derived" as const,
                    state: "ready" as const,
                    data: [{ id: "first", cost: 5 }],
                  },
                ],
                missingIds: [],
              };
        },
        summary: async () => ({ cost: 5 }),
      },
    });
    const { result } = renderHook(
      () =>
        useInfiniteTableList({
          queryOptions,
          buildFilters: () => ({}),
          tableState,
        }),
      { wrapper },
    );
    await waitFor(() => expect(signals).toHaveLength(1));
    await act(async () => {
      const invalidation = invalidateOperationTags(
        client,
        entityRipple("expense"),
      );
      expect(signals[0]?.aborted).toBe(true);
      old.resolve({
        groups: [
          { id: "derived", state: "ready", data: [{ id: "first", cost: 999 }] },
        ],
        missingIds: [],
      });
      await invalidation;
    });
    await waitFor(() =>
      expect(result.current.data).toEqual([{ id: "first", cost: 5 }]),
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("ignores a late group after a filter transition and retains the new group's error", async () => {
    const old = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; cost: number }[];
      }[];
      missingIds: string[];
    }>();
    let oldSignal: AbortSignal | undefined;
    const queryOptions = ({ filters }: { filters: TestFilters }) => ({
      queryKey: ["staged-filter", filters.scope],
      execute: async () => ({
        ...page(filters.scope, 0, 1),
        deferredGroups: [{ id: "derived" as const, fields: ["cost"] }],
      }),
      progressive: {
        enrich: async (
          _ids: string[],
          _groups: ("media" | "quality" | "relations" | "derived")[],
          signal: AbortSignal,
        ) => {
          if (filters.scope === "old") {
            oldSignal = signal;
            return old.promise;
          }
          return {
            groups: [
              {
                id: "derived" as const,
                state: "error" as const,
                error: {
                  code: "INTERNAL_SERVER_ERROR",
                  message: "Synthetic derived failure",
                },
              },
            ],
            missingIds: [],
          };
        },
        summary: async () => ({ cost: filters.scope === "old" ? 999 : 5 }),
      },
    });
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useInfiniteTableList({
          queryOptions,
          buildFilters: () => ({ scope }),
          tableState,
        }),
      { initialProps: { scope: "old" }, wrapper: createWrapper() },
    );
    await waitFor(() => expect(oldSignal).toBeDefined());
    rerender({ scope: "new" });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "new" }]));
    await waitFor(() =>
      expect(result.current.enrichmentState("new", "cost")).toMatchObject({
        state: "error",
        error: "Synthetic derived failure",
      }),
    );
    expect(oldSignal?.aborted).toBe(true);
    await act(async () =>
      old.resolve({
        groups: [
          { id: "derived", state: "ready", data: [{ id: "new", cost: 999 }] },
        ],
        missingIds: [],
      }),
    );
    expect(result.current.data).toEqual([{ id: "new" }]);
    expect(result.current.sums).toEqual({ cost: 5 });
  });

  it("renders base rows before deferred fields and totals, and cancels them on refresh", async () => {
    const enrichment = Promise.withResolvers<{
      groups: {
        id: "derived";
        state: "ready";
        data: { id: string; cost: number }[];
      }[];
      missingIds: string[];
    }>();
    const summary = Promise.withResolvers<{ cost: number }>();
    let enrichmentSignal: AbortSignal | undefined;
    const queryOptions = () => ({
      queryKey: ["progressive-boundary"],
      execute: async () => ({
        ...page("first", 0, 1),
        deferredGroups: [{ id: "derived" as const, fields: ["cost"] }],
      }),
      progressive: {
        enrich: async (
          _ids: string[],
          _groups: ("media" | "quality" | "relations" | "derived")[],
          signal: AbortSignal,
        ) => {
          enrichmentSignal = signal;
          return enrichment.promise;
        },
        summary: async () => summary.promise,
      },
    });
    const { result, unmount } = renderHook(
      () =>
        useInfiniteTableList({
          queryOptions,
          buildFilters: () => ({ scope: "same" }),
          tableState,
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.data).toEqual([{ id: "first" }]));
    await waitFor(() =>
      expect(result.current.enrichmentState("first", "cost")).toEqual({
        state: "loading",
      }),
    );
    expect(result.current.sums).toBeUndefined();
    expect(result.current.summaryState.state).toBe("loading");
    unmount();
    expect(enrichmentSignal?.aborted).toBe(true);
    enrichment.resolve({
      groups: [
        { id: "derived", state: "ready", data: [{ id: "first", cost: 99 }] },
      ],
      missingIds: [],
    });
    summary.resolve({ cost: 99 });
  });

  it("keeps operation cache tags on the infinite query", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const queryFn = vi.fn(async () => page("expense-1", 0, 1));
    const cacheTags = [["entity", "list"], ["expense"]] as const;
    const queryOptions = () => ({
      queryKey: ["operation", "entity.list", { entity: "expense", input: {} }],
      meta: { cacheTags },
      execute: () => queryFn(),
    });

    renderHook(
      () =>
        useInfiniteTableList<TestFilters, TestRow>({
          queryOptions,
          buildFilters: () => ({ scope: "same" }),
          tableState,
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledOnce());
    await invalidateOperationTags(client, entityRipple("expense"));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("forwards TanStack cancellation to the list transport", async () => {
    let receivedSignal: AbortSignal | undefined;
    const queryOptions = () => ({
      queryKey: ["table-abort"],
      execute: (signal: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<ListQueryResponse<TestRow>>(() => {});
      },
    });
    const { unmount } = renderHook(
      () =>
        useInfiniteTableList<TestFilters, TestRow>({
          queryOptions,
          buildFilters: () => ({ scope: "same" }),
          tableState,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(receivedSignal).toBeDefined());
    unmount();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("coalesces overlapping next-page requests", async () => {
    const calls = new Map<number, number>();
    const queryOptions = vi.fn(
      ({ pagination }: { pagination: { pageIndex: number } }) => ({
        queryKey: ["table-list", "same", pagination.pageIndex],
        execute: async () => {
          calls.set(
            pagination.pageIndex,
            (calls.get(pagination.pageIndex) ?? 0) + 1,
          );
          return page(`row-${pagination.pageIndex}`, pagination.pageIndex, 3);
        },
      }),
    );

    const { result } = renderHook(
      () =>
        useInfiniteTableList<TestFilters, TestRow>({
          queryOptions,
          buildFilters: () => ({ scope: "same" }),
          tableState,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.data).toEqual([{ id: "row-0" }]));
    act(() => {
      result.current.infiniteScroll.fetchNextPage();
      result.current.infiniteScroll.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.data).toEqual([{ id: "row-0" }, { id: "row-1" }]),
    );
    expect(calls.get(1)).toBe(1);
  });

  it("keeps stale rows visible but blocks pagination until the new first page swaps in", async () => {
    const nextFirstPage = Promise.withResolvers<ListQueryResponse<TestRow>>();
    const requested: string[] = [];
    const queryOptions = ({
      filters,
      pagination,
    }: {
      filters: TestFilters;
      pagination: { pageIndex: number };
    }) => ({
      queryKey: ["table-transition", filters.scope, pagination.pageIndex],
      execute: async () => {
        requested.push(`${filters.scope}:${pagination.pageIndex}`);
        if (filters.scope === "new" && pagination.pageIndex === 0) {
          return nextFirstPage.promise;
        }
        const result = page(
          `${filters.scope}-${pagination.pageIndex}`,
          pagination.pageIndex,
          2,
        );
        result.meta.sums = { cost: 999 };
        return result;
      },
    });

    const { result, rerender } = renderHook(
      ({ scope }) =>
        useInfiniteTableList<TestFilters, TestRow>({
          queryOptions,
          buildFilters: () => ({ scope }),
          tableState,
        }),
      { initialProps: { scope: "old" }, wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.data).toEqual([{ id: "old-0" }]));
    rerender({ scope: "new" });

    await waitFor(() =>
      expect(result.current.infiniteScroll.isTransitioning).toBe(true),
    );
    expect(result.current.data).toEqual([{ id: "old-0" }]);
    expect(result.current.sums).toBeUndefined();
    expect(result.current.infiniteScroll.hasNextPage).toBe(false);
    act(() => result.current.infiniteScroll.fetchNextPage());
    expect(requested).not.toContain("new:1");

    act(() =>
      nextFirstPage.resolve({
        ...page("new-0", 0, 2),
        meta: { pageIndex: 0, pageSize: 1, totalCount: 2, sums: { cost: -10 } },
      }),
    );
    await waitFor(() => {
      expect(result.current.infiniteScroll.isTransitioning).toBe(false);
      expect(result.current.data).toEqual([{ id: "new-0" }]);
      expect(result.current.sums).toEqual({ cost: -10 });
    });
  });
});
