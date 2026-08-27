import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ListWorkbench, type ListWorkbenchModel } from "./ListWorkbench";
import type { CubbyTable } from "./table-features";

type TestRow = { id: string; name: string };

const { renderTable } = vi.hoisted(() => ({
  renderTable: vi.fn((props: Record<string, unknown>) => (
    <div data-testid="raw-table">
      {props.additionalToolbarContent as ReactNode}
      {props.emptyState as ReactNode}
    </div>
  )),
}));

vi.mock("./Table", () => ({ default: renderTable }));

const table = {} as CubbyTable<TestRow>;

describe("ListWorkbench", () => {
  it("renders a page-list model without caller prop choreography", () => {
    const onGroupedChange = vi.fn();
    const model: ListWorkbenchModel<TestRow> = {
      entity: "product",
      table,
      isLoading: true,
      error: new Error("query failed"),
      timing: { durationMs: 14, isFresh: true },
      bulkActionBar: <span>Bulk actions</span>,
      deleteDialog: <div>Delete Product</div>,
      infiniteScroll: { hasNextPage: false } as never,
      refreshControls: { onRefresh: vi.fn(), isRefreshing: false },
      groupConfig: {
        field: "category",
        keyFn: () => "Tools",
        colorFn: () => "ochre",
      },
      grouped: true,
      onGroupedChange,
    };

    render(<ListWorkbench model={model} ariaLabel="Products" />);

    const props = renderTable.mock.lastCall?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({
      table,
      entity: "product",
      isLoading: true,
      error: model.error,
      timing: model.timing,
      bulkActionBar: model.bulkActionBar,
      infiniteScroll: model.infiniteScroll,
      refreshControls: model.refreshControls,
      groupConfig: model.groupConfig,
      grouped: true,
      onGroupedChange,
      embedded: false,
      toolbarMode: "auto",
      ariaLabel: "Products",
    });
    expect(screen.getByText("Delete Product")).toBeTruthy();
  });

  it("gives an embedded relationship ledger compact chrome and keeps domain choices local", () => {
    const model: ListWorkbenchModel<TestRow> = {
      entity: "expense",
      table,
    };

    render(
      <ListWorkbench
        model={model}
        mode="embedded"
        ariaLabel="Product expenses"
        contextualStatus={<span>Net cost: $42</span>}
        emptyState={<span>No expenses linked</span>}
        showColumnMenu
      />,
    );

    const props = renderTable.mock.lastCall?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({
      table,
      entity: "expense",
      embedded: true,
      toolbarMode: "internal",
      showColumnMenu: true,
      ariaLabel: "Product expenses",
    });
    expect(screen.getByText("Net cost: $42")).toBeTruthy();
    expect(screen.getByText("No expenses linked")).toBeTruthy();
  });

  it("passes current-record state and an optional desktop inspector to page tables", () => {
    const model: ListWorkbenchModel<TestRow> = {
      entity: "product",
      table,
    };

    render(
      <ListWorkbench
        model={model}
        currentRowId="PRD-4K7M"
        desktopInspector={<aside>Product inspector</aside>}
        inspectorToggle={<button type="button">Toggle inspector</button>}
      />,
    );

    const props = renderTable.mock.lastCall?.[0] as Record<string, unknown>;
    expect(props.currentRowId).toBe("PRD-4K7M");
    expect(props.desktopInspector).toBeTruthy();
    expect(props.inspectorToggle).toBeTruthy();
  });
});
