import { fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import type { FilterConfig } from "~/ui/data-table/table-meta";
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

function Harness({
  onRowClick,
  embedded = false,
  printable = false,
  filterConfig,
}: {
  onRowClick: (id: string) => void;
  embedded?: boolean;
  printable?: boolean;
  filterConfig?: FilterConfig;
}) {
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", { header: "Name", meta: { filterConfig } }),
      ]),
    [filterConfig],
  );
  const table = useCubbyTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
  });
  return (
    <RTable
      table={table}
      printable={printable}
      ariaLabel="Synthetic rows"
      withoutImages="Fixture: row stepping needs no columns beyond a name."
      currentRowId="row-150"
      onRowClick={(row) => onRowClick(row.id)}
      embedded={embedded}
      {...(embedded
        ? {
            inspector: {
              content: <StepButtons />,
              title: "Synthetic inspector",
              onClose: () => {},
            },
          }
        : { desktopInspector: <StepButtons /> })}
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

  it("warns for missing multiselect choices and skips deferred rosters", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filterConfig: FilterConfig = {
      placeholder: "Filter name",
      filterType: "multiselect",
      options: [{ value: "known", label: "Known" }],
    };
    try {
      const { unmount } = render(
        <Harness onRowClick={() => {}} filterConfig={filterConfig} />,
        { wrapper: harness.wrapper },
      );
      expect(warn).toHaveBeenCalledWith(
        "RTable column name displays a value absent from its multiselect choices.",
      );
      unmount();
      warn.mockClear();
      render(
        <Harness
          onRowClick={() => {}}
          filterConfig={{ ...filterConfig, onActivate: () => {} }}
        />,
        { wrapper: harness.wrapper },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps offscreen loaded rows in the print projection", () => {
    render(<Harness onRowClick={() => {}} printable />, {
      wrapper: harness.wrapper,
    });
    const tables = screen.getAllByRole("table", {
      name: "Synthetic rows",
      hidden: true,
    });
    expect(within(tables[0]!).queryByText("Synthetic row 199")).toBeNull();
    expect(
      within(tables[1]!).getByText("Synthetic row 199"),
    ).toBeInTheDocument();
  });

  it.each([false, true])(
    "steps through unmounted rows with embedded=%s",
    (embedded) => {
      const onRowClick = vi.fn();
      render(<Harness onRowClick={onRowClick} embedded={embedded} />, {
        wrapper: harness.wrapper,
      });
      expect(screen.queryByText("Synthetic row 150")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(onRowClick).toHaveBeenLastCalledWith("row-151");
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      expect(onRowClick).toHaveBeenLastCalledWith("row-149");
    },
  );
});
