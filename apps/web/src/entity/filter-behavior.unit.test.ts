import { entitySchema } from "@cubby/schemas/entity";
import { describe, expect, it, vi } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { resolveDateRange } from "~/lib/date-range-presets";

import { groupPathFilters } from "./entity-list/group-drill-down";
import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
  FILTER_NONE,
} from "./filters";
import { entityMetadata } from "./metadata";

const queryClient = await metadataQueryClient();

const rangeSpec = (entity: string, columnId: string) => {
  const spec = getEntityFilters(queryClient, entitySchema.parse(entity)).find(
    (candidate) => candidate.columnId === columnId,
  );
  if (spec?.expand === undefined)
    throw new Error(`${entity}.${columnId} has no preset expander`);
  return spec;
};
const expand = (entity: string, columnId: string, preset: string) =>
  rangeSpec(entity, columnId).expand?.(preset);

describe("declared range presets", () => {
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

  it.each([
    ["1m", "2026-02-28"],
    ["30d", "2026-03-01"],
    ["90d", "2025-12-31"],
    ["ytd", "2026-01-01"],
    ["1y", "2025-03-31"],
  ])("resolves %s into inclusive household dates", (preset, dateFrom) => {
    expect(resolveDateRange(preset, "2026-03-31")).toEqual({
      dateFrom,
      dateTo: "2026-03-31",
    });
  });
  it("clamps calendar months and years over leap days", () => {
    expect(resolveDateRange("1m", "2024-03-31")).toEqual({
      dateFrom: "2024-02-29",
      dateTo: "2024-03-31",
    });
    expect(resolveDateRange("1y", "2024-02-29")).toEqual({
      dateFrom: "2023-02-28",
      dateTo: "2024-02-29",
    });
    const fields = getEntityFilters(queryClient, "product");
    for (const [bucket, start, end] of [
      ["day", "2026-03-08", "2026-03-08"],
      ["week", "2026-03-02", "2026-03-08"],
      ["month", "2024-02-01", "2024-02-29"],
      ["quarter", "2026-01-01", "2026-03-31"],
      ["year", "2024-01-01", "2024-12-31"],
    ] as const) {
      const drilled = groupPathFilters(
        {
          groupBy: [{ key: "createdAt", bucket }],
          grouping: entityMetadata(queryClient, "product").listFields.grouping,
          fields,
          groups: [],
        },
        [start],
      );
      expect(drilled).toBeDefined();
      expect(
        buildFiltersFromManifest(
          fields,
          filterGetterFromColumnFilters(drilled ?? []),
        ),
      ).toEqual({
        createdFrom: start,
        createdTo: end,
      });
    }
    const missingDate = groupPathFilters(
      {
        groupBy: [{ key: "purchaseDate", bucket: "month" }],
        grouping: entityMetadata(queryClient, "product").listFields.grouping,
        fields,
        groups: [],
      },
      [FILTER_NONE],
    );
    expect(missingDate).toBeDefined();
    expect(
      buildFiltersFromManifest(
        fields,
        filterGetterFromColumnFilters(missingDate ?? []),
      ),
    ).toEqual({ purchaseDatePresenceFilter: "none" });
    const booleanFields = getEntityFilters(queryClient, "ingredient");
    for (const value of ["true", "false"]) {
      const drilled = groupPathFilters(
        {
          groupBy: [{ key: "usuallyOnHand" }],
          grouping: entityMetadata(queryClient, "ingredient").listFields
            .grouping,
          fields: booleanFields,
          groups: [],
        },
        [value],
      );
      expect(drilled).toBeDefined();
      expect(
        buildFiltersFromManifest(
          booleanFields,
          filterGetterFromColumnFilters(drilled ?? []),
        ),
      ).toEqual({ usuallyOnHand: value === "true" });
    }
  });
  it("anchors today to the household day across UTC midnight", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T04:00:00Z"));
      expect(resolveDateRange("ytd")).toEqual({
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
