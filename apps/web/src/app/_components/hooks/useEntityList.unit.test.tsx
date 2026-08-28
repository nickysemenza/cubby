import { queryOptions } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { useEntityList } from "./useEntityList";

interface TestRow {
  id: string;
}

const TEST_ROWS: TestRow[] = [{ id: "PRD-ONE" }, { id: "PRD-TWO" }];
const SELECTABLE_ROWS: BulkActionsConfig<TestRow> = {
  actions: [
    {
      id: "inspect",
      label: "Inspect",
      onExecute: async () => ({ success: true }),
    },
  ],
};

const listQueryOptions = () =>
  queryOptions({
    queryKey: ["test", "entity-list"],
    queryFn: async () => ({
      items: TEST_ROWS,
      // The returned page intentionally has more rows than its page size. The
      // server list hook owns accumulation, while the table must render every
      // accumulated row rather than applying client pagination a second time.
      meta: { pageIndex: 0, pageSize: 1, totalCount: 500 },
    }),
  });

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(async () => {
  harness = createBrowserTestHarness();
  await act(async () => {
    await harness.loadRouter();
  });
});

afterEach(() => {
  harness.dispose();
});

describe("useEntityList", () => {
  it("renders every accumulated server row while retaining the server total", async () => {
    const { result } = renderHook(
      () =>
        useEntityList<TestRow, Record<string, never>>({
          entity: "product",
          queryOptions: listQueryOptions,
          buildFilters: () => ({}),
          columns: [],
        }),
      { wrapper: harness.routerWrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));

    expect(result.current.totalCount).toBe(500);
    expect(
      result.current.workbench.table.getRowModel().rows.map((row) => row.id),
    ).toEqual(["PRD-ONE", "PRD-TWO"]);
  });

  it("keeps entity ids as table row ids when selection is unavailable", async () => {
    const { result } = renderHook(
      () =>
        useEntityList<TestRow, Record<string, never>>({
          entity: "product",
          queryOptions: listQueryOptions,
          buildFilters: () => ({}),
          columns: [],
        }),
      { wrapper: harness.routerWrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));

    expect(result.current.workbench.table.getRow("PRD-TWO").original).toEqual({
      id: "PRD-TWO",
    });
  });

  it("clears a bulk selection when its query scope changes", async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useEntityList<TestRow, { scope: string }>({
          entity: "product",
          queryOptions: listQueryOptions,
          buildFilters: () => ({ scope }),
          bulkActions: SELECTABLE_ROWS,
          columns: [],
        }),
      { initialProps: { scope: "first" }, wrapper: harness.routerWrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    act(() => {
      result.current.workbench.table.getRow("PRD-ONE").toggleSelected(true);
    });
    await waitFor(() =>
      expect(result.current.workbench.table.atoms.rowSelection?.get()).toEqual({
        "PRD-ONE": true,
      }),
    );

    rerender({ scope: "second" });

    await waitFor(() =>
      expect(result.current.workbench.table.atoms.rowSelection?.get()).toEqual(
        {},
      ),
    );
  });
});
