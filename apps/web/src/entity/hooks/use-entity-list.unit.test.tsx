import { flexRender } from "@tanstack/react-table";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";

import type { ListEnrichmentResponse } from "./progressive-list";
import { useEntityList } from "./use-entity-list";

installFeatures();

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
  it("keeps a saved category usable while hidden AI evidence loads or fails", async () => {
    const gate = Promise.withResolvers<ListEnrichmentResponse>();
    const helper = createCubbyColumnHelper<TestRow>();
    const columns = createCubbyColumnCollection<TestRow>((add) => {
      add(
        helper.display({
          id: "categoryId",
          cell: () => <a href="/categories/synthetic">Saved category</a>,
        }),
      );
    });
    let attempted = false;
    const queryOptions = () => ({
      queryKey: ["test", "category-basis-readiness"],
      execute: async () => ({
        items: [TEST_ROWS[0]!],
        meta: { pageIndex: 0, pageSize: 25, totalCount: 1 },
        deferredGroups: [
          { id: "quality" as const, fields: ["classificationEvidence"] },
        ],
      }),
      progressive: {
        enrich: async (): Promise<ListEnrichmentResponse> => {
          if (!attempted) {
            attempted = true;
            return gate.promise;
          }
          return {
            groups: [
              {
                id: "quality",
                fields: ["classificationEvidence"],
                state: "ready",
                data: [{ id: TEST_ROWS[0]!.id, classificationEvidence: null }],
              },
            ],
            missingIds: [],
          };
        },
        summary: async () => ({}),
      },
    });
    function CategoryTable() {
      const list = useEntityList<TestRow, Record<string, never>>({
        entity: "product",
        queryOptions,
        buildFilters: () => ({}),
        columns,
      });
      const cell = list.workbench.table
        .getRowModel()
        .rows[0]?.getVisibleCells()
        .find((entry) => entry.column.id === "categoryId");
      return (
        <>
          {cell && flexRender(cell.column.columnDef.cell, cell.getContext())}
          <output aria-label="AI basis readiness">
            {String(
              list.workbench.isFieldReady?.(
                TEST_ROWS[0]!.id,
                "classificationEvidence",
              ),
            )}
          </output>
          <button onClick={() => void list.retryEnrichment(0, "quality")}>
            Retry evidence
          </button>
        </>
      );
    }
    render(<CategoryTable />, { wrapper: harness.routerWrapper });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Saved category" }),
      ).toBeVisible(),
    );
    expect(screen.getByLabelText("AI basis readiness")).toHaveTextContent(
      "false",
    );
    await act(async () =>
      gate.resolve({
        groups: [
          {
            id: "quality",
            state: "error",
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Synthetic evidence failure",
            },
          },
        ],
        missingIds: [],
      }),
    );
    expect(
      screen.getByRole("link", { name: "Saved category" }),
    ).toHaveAttribute("href", "/categories/synthetic");
    expect(screen.getByLabelText("AI basis readiness")).toHaveTextContent(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry evidence" }));
    await waitFor(() =>
      expect(screen.getByLabelText("AI basis readiness")).toHaveTextContent(
        "true",
      ),
    );
    expect(screen.getByRole("link", { name: "Saved category" })).toBeVisible();
  });

  it("accepts typed dialog and pagination search alongside list filters", async () => {
    harness.dispose();
    harness = createBrowserTestHarness({
      initialPath: "/?create=true&pageIndex=2&search=Pantry",
    });
    await act(async () => {
      await harness.loadRouter();
    });
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
    expect(harness.router.state.location.search).toMatchObject({
      create: true,
      pageIndex: 2,
      search: "Pantry",
    });
  });

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
        entityKind: "product",
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
