import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entity/display/entity-display";
import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "../../ui/data-table/table-features";
import { createImageColumn } from "./column-helpers";
import { ListWorkbench, useBoundedListWorkbench } from "./list-workbench";
import { useChildListWorkbench } from "./use-child-list-workbench";
import { useTableState } from "./use-table-state";

installFeatures();

interface TestRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  createImageColumn(helper, { entity: "product", getImages: () => [] }),
  helper.accessor("name", {
    header: "Name",
    id: "name",
    meta: { filterConfig: { placeholder: "Filter name…" } },
  }),
]);
const browserHarnesses: Array<ReturnType<typeof createBrowserTestHarness>> = [];

function WorkbenchHarness({
  mode = "page",
  populated = mode === "page",
  multipage = false,
}: {
  mode?: "page" | "embedded";
  populated?: boolean;
  multipage?: boolean;
}) {
  const table = useCubbyTable({
    data: populated ? [{ id: "PRD-4K7M", name: "Hammer" }] : [],
    columns,
    getRowId: (row) => row.id,
    rowCount: multipage ? 60 : undefined,
  });
  return (
    <ListWorkbench
      model={{
        entity: "product",
        table,
        bulkActionBar: <span>Bulk actions</span>,
        bulkActionPreview: [{ id: "archive", label: "Archive selected" }],
        deleteDialog: <div>Delete Product</div>,
      }}
      mode={mode}
      ariaLabel="Products"
      actions={<button type="button">Record sale</button>}
      showColumnMenu={mode === "embedded" && multipage}
      contextualStatus={<span>Net cost: $42</span>}
      emptyState={<span>No products linked</span>}
    />
  );
}

async function renderWorkbench(props?: Parameters<typeof WorkbenchHarness>[0]) {
  const browser = createBrowserTestHarness();
  browserHarnesses.push(browser);
  await act(async () => {
    await browser.loadRouter();
  });
  return render(<WorkbenchHarness {...props} />, {
    wrapper: browser.routerWrapper,
  });
}

afterEach(() => {
  for (const browser of browserHarnesses) browser.dispose();
  browserHarnesses.length = 0;
});

describe("ListWorkbench", () => {
  it("renders the real page table with its shared status and deletion chrome", async () => {
    await renderWorkbench();

    expect(await screen.findByText("Hammer")).toBeVisible();
    expect(screen.getByText("Net cost: $42")).toBeVisible();
    expect(screen.getByText("Delete Product")).toBeVisible();
    // An unpaged in-memory table has no pages; its pager once read
    // 9007199254740991 rows per page.
    expect(screen.queryByText("Rows per page")).not.toBeInTheDocument();

    // Page mode folds Columns/Saved views into `Actions ▾` (L3) instead of
    // standalone Display/Saved views triggers.
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      await screen.findByRole("menuitem", { name: /Columns/ }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Saved views/ })).toBeVisible();
    // Bulk verbs are discoverable before any row is selected, but inert.
    expect(
      screen.getByRole("menuitem", { name: "Archive selected" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps an embedded relationship ledger's empty copy in the real table", async () => {
    await renderWorkbench({ mode: "embedded" });

    expect(await screen.findByText("No products linked")).toBeVisible();
    expect(screen.getByText("Net cost: $42")).toBeVisible();
    expect(screen.getByText("Delete Product")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Saved views" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Rows per page")).not.toBeInTheDocument();
  });

  it("keeps useful embedded tools and multipage navigation in compact chrome", async () => {
    await renderWorkbench({
      mode: "embedded",
      populated: true,
      multipage: true,
    });

    expect(await screen.findByText("Hammer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Columns" })).toBeVisible();
    // The title field renders as a search input, not an add-filter button.
    expect(screen.getByRole("textbox", { name: /^Search/ })).toBeVisible();
    expect(screen.getByText("Bulk actions")).toBeVisible();
    expect(screen.getByRole("button", { name: "Record sale" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Go to next page" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Saved views" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Rows per page")).not.toBeInTheDocument();
  });
});

// A retained event handler and an in-flight action outlive the render that
// created them. E2E cannot deterministically hold both React selection lifetimes.
describe("child workbench selection scopes", () => {
  const childColumns = createCubbyColumnCollection<TestRow>((add) => {
    add(helper.accessor("name", { header: "Name", id: "name" }));
  });
  async function mountChild() {
    const browser = createBrowserTestHarness();
    browserHarnesses.push(browser);
    await browser.loadRouter();
    const nextPage = Promise.withResolvers<ListQueryResponse<TestRow>>();
    const completion = Promise.withResolvers<{ success: boolean }>();
    let executions = 0;
    const read: ListQueryOptionsFn<string, TestRow> = ({
      filters,
      pagination,
    }) => ({
      queryKey: ["child-selection", filters, pagination.pageSize],
      execute: async () =>
        filters === "first"
          ? {
              items: [
                { id: "00000000-0000-4000-8000-000000000001", name: "Hammer" },
              ],
              meta: { ...pagination, totalCount: 1 },
            }
          : nextPage.promise,
    });
    const hook = renderHook(
      ({ scope }) => {
        const tableState = useTableState({ readUrlState: false });
        return useChildListWorkbench({
          read,
          filters: scope,
          tableState,
          columns: childColumns,
          navigation: { kind: "none" },
          selection: {
            actions: [
              {
                id: "settle",
                label: "Settle selected",
                onExecute: async () => {
                  executions += 1;
                  return completion.promise;
                },
              },
            ],
          },
        });
      },
      { initialProps: { scope: "first" }, wrapper: browser.routerWrapper },
    );
    await waitFor(() => expect(hook.result.current.data).toHaveLength(1));
    const select = () =>
      act(() =>
        hook.result.current.model.table
          .getRowModel()
          .rows[0]?.toggleSelected(true),
      );
    const resolveNext = async () => {
      await act(async () =>
        nextPage.resolve({
          items: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Hammer, new scope",
            },
          ],
          meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
        }),
      );
      await waitFor(() =>
        expect(hook.result.current.data[0]?.name).toBe("Hammer, new scope"),
      );
    };
    return {
      ...hook,
      select,
      resolveNext,
      completion,
      executions: () => executions,
    };
  }

  it("clears selection and rejects retained actions while another scope's rows are placeholders", async () => {
    const child = await mountChild();
    child.select();
    const oldBar = render(child.result.current.model.bulkActionBar);
    expect(
      screen.getByRole("button", { name: "Settle selected" }),
    ).toBeEnabled();
    child.rerender({ scope: "second" });
    expect(
      child.result.current.model.table.getFilteredSelectedRowModel().rows,
    ).toHaveLength(0);
    expect(
      child.result.current.model.table.getRowModel().rows[0]?.getCanSelect(),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Settle selected" }));
    expect(child.executions()).toBe(0);
    oldBar.unmount();
    await child.resolveNext();
    child.select();
    expect(
      child.result.current.model.table.getFilteredSelectedRowModel().rows,
    ).toHaveLength(1);
    await act(async () => child.completion.resolve({ success: true }));
  });

  it("keeps a new same-ID selection after returning to a scope while its old action completes", async () => {
    const child = await mountChild();
    child.select();
    const oldBar = render(child.result.current.model.bulkActionBar);
    fireEvent.click(screen.getByRole("button", { name: "Settle selected" }));
    expect(child.executions()).toBe(1);
    child.rerender({ scope: "second" });
    await child.resolveNext();
    child.rerender({ scope: "first" });
    await waitFor(() =>
      expect(child.result.current.data[0]?.name).toBe("Hammer"),
    );
    child.select();
    await act(async () => child.completion.resolve({ success: true }));
    expect(
      child.result.current.model.table.getFilteredSelectedRowModel().rows,
    ).toHaveLength(1);
    oldBar.unmount();
  });
});

// Default columns are the declarations' `listHidden` and field order; there is
// no separate default-column list to drift from them.
describe("declared default columns", () => {
  it("starts near-constant columns hidden and leads with the informative ones", () => {
    const inventoryHelper = createCubbyColumnHelper<{ id: string }>();
    const { result } = renderHook(() =>
      useBoundedListWorkbench({
        entity: "inventory",
        data: [],
        columns: createEntityDisplayColumns("inventory", inventoryHelper),
        initialColumnVisibility: entityListHiddenColumns("inventory"),
        getRowId: (row) => row.id,
      }),
    );
    const visible = result.current.table
      .getVisibleLeafColumns()
      .map((column) => column.id);
    expect(visible).not.toContain("placement");
    // Pantry quantities ("3 cans") stay visible on every client.
    expect(visible).toContain("amount");
    const informative = ["ownerLedgerPartyId", "valuation", "verifiedAt"];
    expect(visible.filter((id) => informative.includes(id))).toEqual(
      informative,
    );
  });
});
