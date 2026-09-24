import { describe, expect, it } from "vitest";
import {
  batchLookupBody,
  listFoodsQuery,
  MAX_BATCH_LOOKUP_SIZE,
  MAX_LIST_FOODS_PAGE_SIZE,
} from "./index";

// Only the contract's non-obvious coercion/bounds logic is worth pinning here —
// the endpoint shapes and "does zod validate a valid object" cases are just the
// contract (and zod) restated, so they're not tested.
describe("listFoodsQuery", () => {
  it("enforces hard pagination bounds (and integer coercion from querystrings)", () => {
    expect(
      listFoodsQuery.parse({
        pageIndex: "0",
        pageSize: String(MAX_LIST_FOODS_PAGE_SIZE),
      }).pageSize,
    ).toBe(MAX_LIST_FOODS_PAGE_SIZE);

    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => listFoodsQuery.parse({ pageIndex: "-1" })).toThrow();
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => listFoodsQuery.parse({ pageIndex: "1.5" })).toThrow();
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => listFoodsQuery.parse({ pageSize: "0" })).toThrow();
    expect(
      () =>
        listFoodsQuery.parse({
          pageSize: String(MAX_LIST_FOODS_PAGE_SIZE + 1),
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
    // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    expect(() => listFoodsQuery.parse({ pageSize: "1.5" })).toThrow();
  });

  it("parses foodsOnly from a querystring without the coerce footgun", () => {
    // The bug being guarded: z.coerce.boolean() turned "false" into true.
    expect(listFoodsQuery.parse({ foodsOnly: "true" }).foodsOnly).toBe(true);
    expect(listFoodsQuery.parse({ foodsOnly: "false" }).foodsOnly).toBe(false);
    expect(listFoodsQuery.parse({ foodsOnly: true }).foodsOnly).toBe(true);
    expect(listFoodsQuery.parse({}).foodsOnly).toBeUndefined();
  });
});

describe("batchLookupBody", () => {
  it("enforces the max batch lookup size", () => {
    const lookups = Array.from({ length: MAX_BATCH_LOOKUP_SIZE }, (_, i) => ({
      kind: "fdc" as const,
      fdc_id: i + 1,
    }));

    expect(() => batchLookupBody.parse({ lookups })).not.toThrow();
    expect(
      () =>
        batchLookupBody.parse({
          lookups: [...lookups, { kind: "fdc", fdc_id: 999_999 }],
        }),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });
});
