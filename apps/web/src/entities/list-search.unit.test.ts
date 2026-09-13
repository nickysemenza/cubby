import { describe, expect, it } from "vitest";
import { z } from "zod";

import { unparsedStartOperationDataSchema } from "~/server/start-operation.contract";

import { compileEntityListInput } from "./entity-list.functions";
import * as listSearch from "./list-search";
import { expenseListLoaderDeps, expenseSearchSchema } from "./list-search";

const { productSearchSchema } = listSearch;

/**
 * Every `xSearchDefaults` export mirrors a subset of its schema's keys for
 * `stripSearchParams`. `listSearchSchema`'s `strip` option (see its doc
 * comment in `list-search.ts`) makes the common case — every default is
 * `undefined` — a compile-time guarantee: a stale key is a type error there.
 * A few defaults still can't go through `strip` (a canonical non-`undefined`
 * default; `financeSearchDefaults`, hand-shared by both finance schemas) and
 * need this runtime check instead. Pairs are derived from the module's own
 * exports, not a hand-kept roster — the same trap `strip` exists to avoid.
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

// SAFETY: `Object.entries` on a module with many differently-shaped exports
// collapses `entry[1]` to one giant union no type predicate narrows cleanly
// against; each entry is checked at runtime (instanceof / name suffix)
// before use below.
const moduleEntries = Object.entries(listSearch) as [string, unknown][];

const schemaExports = moduleEntries.filter(
  (entry): entry is [string, z.ZodType] =>
    entry[0].endsWith("SearchSchema") && entry[1] instanceof z.ZodType,
);

const defaultsExports = moduleEntries.filter(
  (entry): entry is [string, object] =>
    entry[0].endsWith("SearchDefaults") &&
    typeof entry[1] === "object" &&
    entry[1] !== null,
);

/**
 * The one naming exception: both finance list schemas share one defaults
 * export whose prefix ("finance") doesn't match either schema's own prefix.
 */
const FINANCE_SCHEMA_PREFIXES = ["financialAccount", "financialTransaction"];

const PAIRS: ReadonlyArray<[string, z.ZodType, object]> = schemaExports.flatMap(
  ([schemaName, schema]) => {
    const prefix = schemaName.replace(/SearchSchema$/, "");
    const defaultsName = FINANCE_SCHEMA_PREFIXES.includes(prefix)
      ? "financeSearchDefaults"
      : `${prefix}SearchDefaults`;
    const defaults = defaultsExports.find(
      ([name]) => name === defaultsName,
    )?.[1];
    return defaults ? [[schemaName, schema, defaults]] : [];
  },
);

describe("list-search defaults parity", () => {
  it("covers every list schema that has a matching defaults export", () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(10);
  });

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
