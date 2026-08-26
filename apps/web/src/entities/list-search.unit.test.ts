import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  expenseSearchDefaults,
  expenseSearchSchema,
  financeSearchDefaults,
  financialAccountSearchSchema,
  financialTransactionSearchSchema,
  locationSearchDefaults,
  locationSearchSchema,
  productSearchDefaults,
  productSearchSchema,
  projectSearchDefaults,
  projectSearchSchema,
  purchaseSearchDefaults,
  purchaseSearchSchema,
  taskSearchDefaults,
  taskSearchSchema,
  vendorSearchDefaults,
  vendorSearchSchema,
  wishSearchDefaults,
  wishSearchSchema,
} from "./list-search";

/**
 * Every `xSearchDefaults` object hand-mirrors its schema's key list for
 * `stripSearchParams`. Nothing structural ties the two together, so a schema
 * key rename would silently leave a stale default behind (which then never
 * strips, polluting every shared URL). Same guard idea as
 * `meal-search.unit.test.ts`'s key parity check.
 */
/**
 * Some list schemas are `.transform()`-wrapped (a Zod pipe) — the object
 * shape then lives on the pipe's input side, not on the schema itself.
 */
function shapeKeys(schema: z.ZodType): string[] {
  const candidate = schema as Partial<{
    shape: z.ZodRawShape;
    in: Partial<{ shape: z.ZodRawShape }>;
  }>;
  const shape = candidate.shape ?? candidate.in?.shape;
  if (!shape) throw new Error("schema has no reachable object shape");
  return Object.keys(shape);
}

const PAIRS: ReadonlyArray<[string, z.ZodType, Record<string, unknown>]> = [
  ["product", productSearchSchema, productSearchDefaults],
  ["location", locationSearchSchema, locationSearchDefaults],
  ["wish", wishSearchSchema, wishSearchDefaults],
  ["project", projectSearchSchema, projectSearchDefaults],
  ["task", taskSearchSchema, taskSearchDefaults],
  ["expense", expenseSearchSchema, expenseSearchDefaults],
  ["vendor", vendorSearchSchema, vendorSearchDefaults],
  ["purchase", purchaseSearchSchema, purchaseSearchDefaults],
  ["financial-account", financialAccountSearchSchema, financeSearchDefaults],
  [
    "financial-transaction",
    financialTransactionSearchSchema,
    financeSearchDefaults,
  ],
];

describe("list-search defaults parity", () => {
  it.each(PAIRS)(
    "%s: every strip-default key exists on the schema",
    (_name, schema, defaults) => {
      const schemaKeys = shapeKeys(schema);
      const stale = Object.keys(defaults).filter(
        (key) => !schemaKeys.includes(key),
      );
      expect(stale).toEqual([]);
    },
  );

  it("preserves nullable category sentinels for Product list filters", () => {
    expect(productSearchSchema.parse({ category: "__none__" })).toMatchObject({
      category: "__none__",
    });
    expect(productSearchSchema.parse({ category: "__any__" })).toMatchObject({
      category: "__any__",
    });
  });
});
