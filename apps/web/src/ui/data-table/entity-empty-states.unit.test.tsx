import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { hasActiveFilters, isNarrowed } from "./entity-empty-states";
import type { CubbyTable as Table } from "./table-features";

/**
 * A URL-only scope (`/expenses?productId=…`) narrows the rows without ever
 * entering `columnFilters` — every entry there has to resolve to a real column.
 * `useTableConfig` reports the count through table meta so an empty result set
 * under a scope still reads as "no matches" rather than "you have nothing yet".
 */
describe("isNarrowed", () => {
  const table = (
    columnFilters: { id: string; value: string[] }[],
    urlScopeCount?: number,
  ) =>
    fromPartial<Table<{ id: string }>>({
      state: { columnFilters },
      options: { meta: urlScopeCount ? { urlScopeCount } : {} },
    });

  it("is false with neither a column filter nor a scope", () => {
    expect(isNarrowed(table([]))).toBe(false);
  });

  it("counts a URL-only scope even with no column filters", () => {
    expect(isNarrowed(table([], 1))).toBe(true);
    // …which `hasActiveFilters` alone can't see — that's the whole point, and
    // why the "Clear filters" button keys off it instead (a scope isn't
    // resettable from the table).
    expect(hasActiveFilters([])).toBe(false);
  });

  it("counts an ordinary column filter", () => {
    expect(isNarrowed(table([{ id: "trade", value: ["drywall"] }]))).toBe(true);
  });
});
