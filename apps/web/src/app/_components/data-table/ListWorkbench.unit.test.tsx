import { act, render, screen } from "@testing-library/react";
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
  helper.accessor("name", { header: "Name", id: "name" }),
]);
const browserHarnesses: Array<ReturnType<typeof createBrowserTestHarness>> = [];

function WorkbenchHarness({ mode = "page" }: { mode?: "page" | "embedded" }) {
  const table = useCubbyTable({
    data: mode === "page" ? [{ id: "PRD-4K7M", name: "Hammer" }] : [],
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <ListWorkbench
      model={{
        entity: "product",
        table,
        bulkActionBar: <span>Bulk actions</span>,
        deleteDialog: <div>Delete Product</div>,
      }}
      mode={mode}
      ariaLabel="Products"
      contextualStatus={<span>Net cost: $42</span>}
      emptyState={<span>No products linked</span>}
    />
  );
}

async function renderWorkbench(mode?: "page" | "embedded") {
  const browser = createBrowserTestHarness();
  browserHarnesses.push(browser);
  await act(async () => {
    await browser.loadRouter();
  });
  return render(<WorkbenchHarness mode={mode} />, {
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
  });

  it("keeps an embedded relationship ledger's empty copy in the real table", async () => {
    await renderWorkbench("embedded");

    expect(await screen.findByText("No products linked")).toBeVisible();
    expect(screen.getByText("Net cost: $42")).toBeVisible();
    expect(screen.getByText("Delete Product")).toBeVisible();
  });
});
