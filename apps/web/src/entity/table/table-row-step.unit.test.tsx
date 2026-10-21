import { fireEvent, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { useTableRowStep } from "~/ui/overlays/side-panel";

import RTable from "./table";

type Row = { id: string; name: string };
const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
  id: `row-${index}`,
  name: `Synthetic row ${index}`,
}));
const helper = createCubbyColumnHelper<Row>();

function StepButtons() {
  const step = useTableRowStep();
  return (
    <>
      <button type="button" onClick={() => step(1)}>
        Next
      </button>
      <button type="button" onClick={() => step(-1)}>
        Previous
      </button>
    </>
  );
}

function Harness({ onRowClick }: { onRowClick: (id: string) => void }) {
  const columns = useMemo(
    () => helper.columns([helper.accessor("name", { header: "Name" })]),
    [],
  );
  const table = useCubbyTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <RTable
      table={table}
      ariaLabel="Synthetic rows"
      withoutImages="Fixture: row stepping needs no columns beyond a name."
      currentRowId="row-150"
      onRowClick={(row) => onRowClick(row.id)}
      desktopInspector={<StepButtons />}
    />
  );
}

// Regression: J/K walked mounted DOM siblings, so once the inspected row
// scrolled out of the virtualized range both keys did nothing.
describe("docked panel row stepping", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => harness.dispose());

  it("steps through the row model when the current row is not mounted", () => {
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />, { wrapper: harness.wrapper });
    expect(screen.queryByText("Synthetic row 150")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onRowClick).toHaveBeenLastCalledWith("row-151");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onRowClick).toHaveBeenLastCalledWith("row-149");
  });
});
