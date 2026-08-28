import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
  it("keeps operation cache tags on the infinite query", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const queryFn = vi.fn(async () => page("expense-1", 0, 1));
    const queryOptions = () => ({
      queryKey: ["operation", "entity.list", { entity: "expense", input: {} }],
      queryFn,
      meta: { cacheTags: [["entity", "list"], ["expense"]] },
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
    await invalidateOperationTags(client, [["expense"]]);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("forwards TanStack cancellation to the list transport", async () => {
    let receivedSignal: AbortSignal | undefined;
    const queryOptions = () => ({
      queryKey: ["table-abort"],
      queryFn: ({ signal }: { signal?: AbortSignal }) => {
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
        queryFn: async () => {
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
    const nextFirstPage = deferred<ListQueryResponse<TestRow>>();
    const requested: string[] = [];
    const queryOptions = ({
      filters,
      pagination,
    }: {
      filters: TestFilters;
      pagination: { pageIndex: number };
    }) => ({
      queryKey: ["table-transition", filters.scope, pagination.pageIndex],
      queryFn: async () => {
        requested.push(`${filters.scope}:${pagination.pageIndex}`);
        if (filters.scope === "new" && pagination.pageIndex === 0) {
          return nextFirstPage.promise;
        }
        return page(
          `${filters.scope}-${pagination.pageIndex}`,
          pagination.pageIndex,
          2,
        );
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
    expect(result.current.infiniteScroll.hasNextPage).toBe(false);
    act(() => result.current.infiniteScroll.fetchNextPage());
    expect(requested).not.toContain("new:1");

    act(() => nextFirstPage.resolve(page("new-0", 0, 2)));
    await waitFor(() => {
      expect(result.current.infiniteScroll.isTransitioning).toBe(false);
      expect(result.current.data).toEqual([{ id: "new-0" }]);
    });
  });
});
