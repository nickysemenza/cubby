import { entitySchema } from "@cubby/schemas/entity";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { describe, expect, it } from "vitest";

import { resolveDateRange } from "./filter-behavior";
import { getEntityFilters } from "./filter-manifest";
import { entityFilterFieldMaps } from "./generated/entity-filter-fields.gen";

const rangeSpec = (entity: string, columnId: string) => {
  const spec = getEntityFilters(entitySchema.parse(entity)).find(
    (candidate) => candidate.columnId === columnId,
  );
  if (spec?.expand === undefined)
    throw new Error(`${entity}.${columnId} has no preset expander`);
  return spec;
};
const expand = (entity: string, columnId: string, preset: string) =>
  rangeSpec(entity, columnId).expand?.(preset);

describe("declared range presets", () => {
  it("expands every declared option into a patch of real filter fields", () => {
    let expanders = 0;
    for (const [entity, fields] of Object.entries(entityFilterFieldMaps)) {
      for (const spec of getEntityFilters(entitySchema.parse(entity))) {
        if (spec.kind !== "range" || spec.expand === undefined) continue;
        for (const option of spec.options ?? []) {
          const patch = spec.expand(option.value);
          // A preset that resolves to nothing renders as a menu entry that
          // silently matches every row.
          if (Object.keys(patch).length === 0) continue;
          expanders += 1;
          for (const key of Object.keys(patch))
            expect(Object.keys(fields), `${entity}.${spec.columnId}`).toContain(
              key,
            );
        }
      }
    }
    expect(expanders).toBeGreaterThan(30);
  });

  it("resolves an unknown or missing preset to no filter", () => {
    expect(expand("expense", "cost", "bogus")).toEqual({});
    expect(expand("expense", "cost", "")).toEqual({});
    // Inherited object keys are not presets.
    expect(expand("expense", "cost", "constructor")).toEqual({});
  });

  it("keeps cost presence sentinels distinct from the amount buckets", () => {
    // `?cost=has` / `?cost=none` bookmarks predate the buckets sharing this
    // control; they write `costPresenceFilter` and nothing else.
    expect(expand("expense", "cost", "has")).toEqual({
      costPresenceFilter: "has",
    });
    expect(expand("expense", "cost", "none")).toEqual({
      costPresenceFilter: "none",
    });
    expect(expand("expense", "cost", "gte500")).toEqual({ costMin: 500 });
  });

  it("resolves credits to an upper bound of zero, never a positive floor", () => {
    // Credits are real in this ledger (refunds, price adjustments); a `costMin`
    // here would silently invert the filter.
    expect(expand("expense", "cost", "credits")).toEqual({ costMax: 0 });
    expect(expand("financialTransaction", "amount", "credits")).toEqual({
      amountMax: 0,
    });
    expect(expand("purchase", "expenseTotal", "nonpositive")).toEqual({
      expenseTotalMax: 0,
    });
  });

  it("emits numeric bounds and inclusive quantity windows", () => {
    expect(expand("expense", "productQuantity", "exactly1")).toEqual({
      productQuantityMin: 1,
      productQuantityMax: 1,
    });
    expect(expand("recipe", "costTotal", "10to25")).toEqual({
      costTotalMin: 10,
      costTotalMax: 25,
    });
  });

  it("splits unpriced products into real ones and misc buckets", () => {
    // `misc:` buckets have no meaningful unit price, so they stay out of the
    // real unpriced worklist.
    expect(expand("product", "price", "none-real")).toEqual({
      pricePresenceFilter: "none",
      miscBucketFilter: "none",
    });
    expect(expand("product", "price", "none-bucket")).toEqual({
      pricePresenceFilter: "none",
      miscBucketFilter: "has",
    });
  });
});

describe("resolveDateRange", () => {
  it("returns {} for an undefined or unrecognized preset", () => {
    expect(resolveDateRange(undefined)).toEqual({});
    expect(resolveDateRange("bogus")).toEqual({});
  });

  it("resolves each preset to an inclusive window ending today", () => {
    const today = new Date();
    const dateTo = format(today, "yyyy-MM-dd");
    expect(resolveDateRange("30d")).toEqual({
      dateFrom: format(subDays(today, 30), "yyyy-MM-dd"),
      dateTo,
    });
    expect(resolveDateRange("90d")).toEqual({
      dateFrom: format(subDays(today, 90), "yyyy-MM-dd"),
      dateTo,
    });
    expect(resolveDateRange("ytd")).toEqual({
      dateFrom: format(startOfYear(today), "yyyy-MM-dd"),
      dateTo,
    });
    expect(resolveDateRange("1y")).toEqual({
      dateFrom: format(subMonths(today, 12), "yyyy-MM-dd"),
      dateTo,
    });
  });
});
