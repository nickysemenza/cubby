import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";

import { TableCellWorkbench } from "./table-cell-workbench";

describe("TableCellWorkbench", () => {
  it("mounts relation content only after its trigger opens", () => {
    const rowClick = vi.fn();

    render(
      <Table>
        <TableBody>
          <TableRow
            aria-label="Purchase row"
            onClick={rowClick}
            onKeyDown={() => undefined}
          >
            <TableCell>
              <TableCellWorkbench
                title="Financial settlement"
                description="Derived from linked transactions."
                summary={<span>Pending · 1</span>}
              >
                <p>Linked transaction evidence</p>
              </TableCellWorkbench>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(
      screen.queryByText("Linked transaction evidence"),
    ).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", {
      name: "Inspect financial settlement",
    });
    fireEvent.click(trigger);

    expect(screen.getByText("Linked transaction evidence")).toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });
});
