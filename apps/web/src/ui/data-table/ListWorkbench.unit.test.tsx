import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ListWorkbench } from "./ListWorkbench";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
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
    expect(screen.getByText("Rows per page")).toBeVisible();

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
