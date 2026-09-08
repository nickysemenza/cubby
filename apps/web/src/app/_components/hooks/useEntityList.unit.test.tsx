import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { createCubbyColumnCollection } from "../data-table/table-features";
import { useEntityList } from "./useEntityList";

interface TestRow {
  id: string;
}

const TEST_ROWS: TestRow[] = [{ id: "PRD-ONE" }, { id: "PRD-TWO" }];
const NO_COLUMNS = createCubbyColumnCollection<TestRow>(() => undefined);
const SELECTABLE_ROWS: BulkActionsConfig<TestRow> = {
  actions: [
    {
      id: "inspect",
      label: "Inspect",
      onExecute: async () => ({ success: true }),
    },
  ],
};

const listQueryOptions = () => ({
  queryKey: ["test", "entity-list"],
  execute: async () => ({
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
          columns: NO_COLUMNS,
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
          columns: NO_COLUMNS,
        }),
      { wrapper: harness.routerWrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));

    expect(result.current.workbench.table.getRow("PRD-TWO").original).toEqual({
      id: "PRD-TWO",
    });
  });

  it("wires the canonical preview into the single-row Inspect action", async () => {
    const { result } = renderHook(
      () =>
        useEntityList<TestRow, Record<string, never>>({
          entity: "product",
          queryOptions: listQueryOptions,
          buildFilters: () => ({}),
          columns: NO_COLUMNS,
          preview: {},
        }),
      { wrapper: harness.routerWrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    act(() => {
      result.current.workbench.table.getRow("PRD-TWO").toggleSelected(true);
    });
    await waitFor(() =>
      expect(
        result.current.workbench.table.getSelectedRowModel().rows,
      ).toHaveLength(1),
    );

    render(result.current.workbench.bulkActionBar);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));

    await waitFor(() =>
      expect(result.current.inspection.preview).toEqual({
        entityType: "product",
        id: "PRD-TWO",
        rowKey: "PRD-TWO",
      }),
    );
  });

  it("clears a bulk selection when its query scope changes", async () => {
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useEntityList<TestRow, { scope: string }>({
          entity: "product",
          queryOptions: listQueryOptions,
          buildFilters: () => ({ scope }),
          bulkActions: SELECTABLE_ROWS,
          columns: NO_COLUMNS,
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
