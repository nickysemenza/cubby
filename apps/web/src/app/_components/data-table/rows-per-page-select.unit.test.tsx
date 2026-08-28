import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RowsPerPageSelect } from "./rows-per-page-select";
import type { CubbyTable as Table } from "./table-features";

/**
 * RowsPerPageSelect only reads `pagination.pageSize` and calls `setPageSize`,
 * so a two-method stub is enough to drive it.
 */
function tableWithPageSize(pageSize: number) {
  return {
    state: { pagination: { pageIndex: 0, pageSize } },
    setPageSize: vi.fn(),
  } as unknown as Table<Record<string, unknown>>;
}

describe("RowsPerPageSelect", () => {
  it("displays an off-scale page size instead of rendering blank", () => {
    // Detail-page tables set bespoke sizes (10, 20, an ingredient count). The
    // combobox shows its matching item's label, so a size with no option used
    // to render an empty box.
    render(<RowsPerPageSelect table={tableWithPageSize(20)} />);
    expect(screen.getByRole("combobox")).toHaveValue("20");
  });
});
