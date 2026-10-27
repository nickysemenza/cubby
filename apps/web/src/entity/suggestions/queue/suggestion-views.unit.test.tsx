import { FILTER_NOT_PREFIX } from "@cubby/schemas/filter-sentinel-fields";
import { describe, expect, it } from "vitest";

import {
  decodeFilters,
  encodeFilters,
  filterGetterFromColumnFilters,
} from "~/entity/filters";

import { buildSuggestionFilters, viewFilterSpecs } from "./suggestion-views";
import { suggestionsSearchSchema } from "./suggestions-search";

describe("Suggestions filters", () => {
  it("round-trips included and excluded values through the route and server codec", () => {
    const specs = viewFilterSpecs("statement_transaction");
    const filters: { id: string; value: string | string[] }[] = [
      { id: "kind", value: ["purchase", `${FILTER_NOT_PREFIX}transfer`] },
      { id: "clean", value: [`${FILTER_NOT_PREFIX}false`] },
      { id: "amount", value: "10..50" },
    ];
    const search = suggestionsSearchSchema.parse(
      encodeFilters(specs, filterGetterFromColumnFilters(filters)),
    );
    expect(search).toMatchObject({
      kind: "purchase",
      kindExclude: "transfer",
      cleanExclude: "false",
      amount: "10..50",
    });
    const decoded = decodeFilters(specs, search);
    expect(decoded).toEqual(expect.arrayContaining(filters));
    const get = filterGetterFromColumnFilters(decoded);
    expect(
      buildSuggestionFilters("statement_transaction", {
        getColumnFilter: (column) => {
          const value = get(column);
          return typeof value === "string" ? value : undefined;
        },
        getColumnFilterValues: (column) => {
          const value = get(column);
          return Array.isArray(value) ? value : undefined;
        },
      }),
    ).toEqual({
      kind: ["purchase"],
      kindExclude: ["transfer"],
      cleanExclude: ["false"],
      amountFrom: 10,
      amountTo: 50,
    });
  });
});
