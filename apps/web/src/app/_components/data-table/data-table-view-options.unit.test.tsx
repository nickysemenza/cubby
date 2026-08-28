import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { columnLabel } from "./data-table-view-options";
import type { CubbyColumn as Column } from "./table-features";

/**
 * The View menu used to render `{column.id}` with a `capitalize` CSS class —
 * fine for a single-word id, but `className="capitalize"` only uppercases the
 * first letter of each *existing* word, so a camelCase id like
 * `quantityVariance` rendered as the raw, unsegmented "QuantityVariance"
 * instead of "Quantity Variance". `columnLabel` is the same header-first,
 * `humanize`-fallback derivation `LedgerFilters` uses.
 */
type TestRow = { id: string };
function column(
  id: string,
  header?: Column<TestRow, unknown>["columnDef"]["header"],
): Column<TestRow, unknown> {
  return fromPartial({ id, columnDef: { header } });
}

describe("columnLabel", () => {
  it("prefers the column's own string header", () => {
    expect(columnLabel(column("fdc_id", "USDA Food"))).toBe("USDA Food");
  });

  it("humanizes a camelCase id when there's no string header", () => {
    expect(columnLabel(column("quantityVariance"))).toBe("Quantity Variance");
  });

  it("humanizes a snake_case id when there's no string header", () => {
    expect(columnLabel(column("fdc_id"))).toBe("Fdc id");
  });

  it("falls back to humanize when the header is a render function, not a string", () => {
    expect(columnLabel(column("dataQuality", () => "Icon header"))).toBe(
      "Data Quality",
    );
  });
});
