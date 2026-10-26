import { FILTER_NOT_PREFIX } from "@cubby/schemas/filter-sentinel-fields";
import { describe, expect, it } from "vitest";

import {
  decodeFilters,
  encodeFilters,
  filterGetterFromColumnFilters,
} from "~/entity/filters";

import { buildWhere, viewFilterSpecs } from "./suggestion-views";
import { suggestionsSearchSchema } from "./suggestions-search";

describe("Suggestions filters", () => {
  it("round-trips included and excluded values through the route and server codec", () => {
    const specs = viewFilterSpecs("statement_transaction");
    const filters = [
      { id: "kind", value: ["purchase", `${FILTER_NOT_PREFIX}transfer`] },
      { id: "clean", value: [`${FILTER_NOT_PREFIX}false`] },
    ];
    const search = suggestionsSearchSchema.parse(
      encodeFilters(specs, filterGetterFromColumnFilters(filters)),
    );
    expect(search).toMatchObject({
      kind: "purchase",
      kindExclude: "transfer",
      cleanExclude: "false",
    });
    const decoded = decodeFilters(specs, search);
    expect(decoded).toEqual(filters);
    const get = filterGetterFromColumnFilters(decoded);
    expect(
      buildWhere("statement_transaction", {
        getColumnFilter: () => undefined,
        getColumnFilterValues: (column) => {
          const value = get(column);
          return Array.isArray(value) ? value : undefined;
        },
      }),
    ).toEqual({
      kind: { in: ["purchase"], notIn: ["transfer"] },
      clean: { notIn: [false] },
    });
  });
});
