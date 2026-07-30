import type { Table } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";
import { hasActiveFilters, isNarrowed } from "./entity-empty-states";

/**
 * A URL-only scope (`/expenses?productId=…`) narrows the rows without ever
 * entering `columnFilters` — every entry there has to resolve to a real column.
 * `useTableConfig` reports the count through table meta so an empty result set
 * under a scope still reads as "no matches" rather than "you have nothing yet".
 */
describe("isNarrowed", () => {
  const table = (columnFilters: unknown[], urlScopeCount?: number) =>
    ({
      getState: () => ({ columnFilters }),
      options: { meta: urlScopeCount ? { urlScopeCount } : {} },
    }) as unknown as Table<unknown>;

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
