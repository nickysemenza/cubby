import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { DataTableToolbar } from "./data-table-toolbar";
import { useCubbyTable } from "./table-features";

function ToolbarHarness({
  entity,
  variant = "page",
  portalWorkbenchUtilities = false,
}: {
  entity?: "product";
  variant?: "page" | "embedded";
  portalWorkbenchUtilities?: boolean;
}) {
  const table = useCubbyTable({
    data: [],
    columns: [],
    getRowId: (row: { id: string }) => row.id,
  });
  return (
    <DataTableToolbar
      table={table}
      entity={entity}
      isTransitioning
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

const browserHarnesses: Array<ReturnType<typeof createBrowserTestHarness>> = [];

afterEach(() => {
  for (const browser of browserHarnesses) browser.dispose();
  browserHarnesses.length = 0;
});

describe("DataTableToolbar query tier", () => {
  it("keeps rest and bulk tiers mounted while disabling both during updates", () => {
    render(<ToolbarHarness />);

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
});
