import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "../../ui/data-table/table-features";
import { DataTableToolbar } from "./data-table-toolbar";

type ToolbarRow = { id: string; name: string };
const helper = createCubbyColumnHelper<ToolbarRow>();
const sortableColumns = helper.columns([
  helper.accessor("name", { header: "Name", enableSorting: true }),
]);

function ToolbarHarness({
  entity,
  variant = "page",
  portalWorkbenchUtilities = false,
  sortable = false,
}: {
  entity?: "product";
  variant?: "page" | "embedded";
  portalWorkbenchUtilities?: boolean;
  sortable?: boolean;
}) {
  const table = useCubbyTable({
    data: [],
    columns: sortable ? sortableColumns : [],
    getRowId: (row: ToolbarRow) => row.id,
  });
  return (
    <DataTableToolbar
      table={table}
      entity={entity}
      isTransitioning={!sortable}
      variant={variant}
      portalWorkbenchUtilities={portalWorkbenchUtilities}
      actions={<button type="button">Create</button>}
      bulkActionBar={
        <div data-bulk-action-bar>
          <button type="button">Delete selected</button>
        </div>
      }
    />
  );
}

// The filter bar's facet and view-count hooks need a client even when idle.
const queryWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

const browserHarnesses: Array<ReturnType<typeof createBrowserTestHarness>> = [];

afterEach(() => {
  for (const browser of browserHarnesses) browser.dispose();
  browserHarnesses.length = 0;
});

describe("DataTableToolbar query tier", () => {
  it("keeps rest and bulk tiers mounted while disabling both during updates", () => {
    render(<ToolbarHarness />, { wrapper: queryWrapper });

    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete selected" }),
    ).toBeDisabled();
    expect(
      screen
        .getByRole("button", { name: "Create" })
        .closest("[data-query-rest]"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Delete selected" })
        .closest("[data-query-bulk]"),
    ).toBeInTheDocument();
  });

  it("keeps display controls but omits page-owned saved views when embedded", async () => {
    const browser = createBrowserTestHarness();
    browserHarnesses.push(browser);
    await act(async () => {
      await browser.loadRouter();
    });
    render(<ToolbarHarness entity="product" variant="embedded" />, {
      wrapper: browser.routerWrapper,
    });

    expect(screen.getByRole("button", { name: "Columns" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Saved views" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Columns" })
        .closest("[data-toolbar-variant]"),
    ).toHaveAttribute("data-toolbar-variant", "embedded");
  });

  it("renders no second toolbar row once the page workbench band is found", async () => {
    const { container } = render(
      <>
        <div data-workbench-utilities />
        <ToolbarHarness portalWorkbenchUtilities />
      </>,
      { wrapper: queryWrapper },
    );
    // `usePageWorkbenchTarget` locates the band in an effect, so the portal
    // lands one tick after mount.
    await screen.findByRole("button", { name: "Create" });

    expect(container.querySelector("[data-toolbar-variant]")).toBeNull();
    expect(
      container
        .querySelector("[data-workbench-utilities]")
        ?.querySelector("[data-query-rest]"),
    ).toBeInTheDocument();
  });

  it("sorts by a column, then flips its order, from the Sort menu", async () => {
    render(<ToolbarHarness sortable />, { wrapper: queryWrapper });

    fireEvent.click(screen.getByRole("button", { name: "Sort: Default" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Name" }));
    const trigger = await screen.findByRole("button", {
      name: /^Sort: Name, /,
    });
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Descending" }),
    );

    expect(
      await screen.findByRole("button", { name: "Sort: Name, descending" }),
    ).toBeInTheDocument();
  });
});
