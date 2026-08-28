import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unparsedStartOperationDataSchema } from "~/server/start-operation.contract";

import { compileEntityListInput } from "./entity-list.functions";
import {
  expenseSearchDefaults,
  expenseListLoaderDeps,
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
function schemaKeys(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  if (schema instanceof z.ZodPipe && schema.in instanceof z.ZodObject)
    return Object.keys(schema.in.shape);
  throw new Error("schema has no reachable object fields");
}

const searchDefaultsSchema = z.record(z.string(), z.json().optional());
type SearchDefaults = z.output<typeof searchDefaultsSchema>;

const PAIRS: ReadonlyArray<[string, z.ZodType, SearchDefaults]> = [
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
      const keys = schemaKeys(schema);
      const stale = Object.keys(defaults).filter((key) => !keys.includes(key));
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

  it("keeps analyzer URL state out of the expense list transport carrier", () => {
    const search = expenseSearchSchema.parse({
      analyzeRows: "costType",
      analyzeColumns: "trade",
      analyzeMetric: "actual",
    });
    const input = compileEntityListInput("expense", search);

    expect(search).toMatchObject({
      analyzeRows: "costType",
      analyzeColumns: "trade",
      analyzeMetric: "actual",
    });
    expect(Object.hasOwn(search, "view")).toBe(false);
    expect(unparsedStartOperationDataSchema.parse(input)).toEqual(input);
  });

  it("omits default expense renderer state from canonical route search", () => {
    const search = expenseSearchSchema.parse({});

    for (const key of [
      "view",
      "analyzeRows",
      "analyzeColumns",
      "analyzeMetric",
      "analyzeCompare",
      "analyzeShow",
    ]) {
      expect(Object.hasOwn(search, key)).toBe(false);
    }
  });

  it("omits renderer-only fields from the expense list loader payload", () => {
    const deps = expenseListLoaderDeps(
      expenseSearchSchema.parse({
        view: "analytics",
        analyzeRows: "costType",
        analyzeColumns: "trade",
        analyzeMetric: "actual",
      }),
    );

    expect(deps).toEqual({ active: false, search: {} });
  });
});
