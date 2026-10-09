import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared/filter";
import { productShortcode } from "@cubby/shared/shortcode";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
  entityFilter,
  entityFilterList,
  MAX_SORTS,
  mcpPaginationFields,
  normalizeSorts,
  sortPaginationCombo,
} from "./pagination";

it("carries ordered full-filter group counts in list metadata", () => {
  const response = buildPaginatedResponse(
    { pageIndex: 0, pageSize: 1 },
    [{ name: "one" }],
    3,
    undefined,
    [
      { key: "category-one", label: "Category one", count: 2 },
      { key: "category-two", label: "Category two", count: 1 },
    ],
  );
  const schema = createPaginatedResponseSchema(z.object({ name: z.string() }));
  expect(schema.parse(response).meta.groups).toEqual(response.meta.groups);
  expect(
    schema.safeParse({
      ...response,
      meta: {
        ...response.meta,
        groups: [{ key: "", label: "Empty", count: 0 }],
      },
    }).success,
  ).toBe(false);
});

describe("exact entity filters", () => {
  const shortcode = productShortcode;

  it("accepts only the internal fallback without weakening the entity schema", () => {
    expect(entityFilter(shortcode).parse("PRD-4K7M")).toBe("PRD-4K7M");
    expect(entityFilter(shortcode).parse(UNRESOLVABLE_ENTITY_FILTER)).toBe(
      UNRESOLVABLE_ENTITY_FILTER,
    );
    expect(entityFilter(shortcode).safeParse("Milwaukee drill").success).toBe(
      false,
    );
    expect(shortcode.safeParse("Milwaukee drill").success).toBe(false);
  });

  it("accepts the internal fallback as a one-or-many value", () => {
    expect(entityFilterList(shortcode).parse(["PRD-4K7M", "PRD-2ABC"])).toEqual(
      ["PRD-4K7M", "PRD-2ABC"],
    );
    expect(entityFilterList(shortcode).parse(UNRESOLVABLE_ENTITY_FILTER)).toBe(
      UNRESOLVABLE_ENTITY_FILTER,
    );
    expect(
      entityFilterList(shortcode).safeParse(["PRD-4K7M", "Milwaukee drill"])
        .success,
    ).toBe(false);
  });
});

describe("MCP pagination", () => {
  const fields = mcpPaginationFields({
    defaultPageSize: 25,
    maxPageSize: 100,
  });
  const schema = z.object(fields);

  it("materializes defaults and rejects invalid page boundaries", () => {
    expect(schema.parse({})).toEqual({ pageIndex: 0, pageSize: 25 });
    for (const input of [
      { pageIndex: -1 },
      { pageIndex: 0.5 },
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
});

describe("normalizeSorts", () => {
  it("keeps a stack in order", () => {
    const first = { orderBy: "location", direction: "asc" as const };
    const second = { orderBy: "price", direction: "desc" as const };
    expect(normalizeSorts([first, second])).toEqual([first, second]);
  });

  it("dedupes by orderBy, first occurrence wins", () => {
    expect(
      normalizeSorts([
        { orderBy: "name", direction: "asc" },
        { orderBy: "name", direction: "desc" },
        { orderBy: "createdAt", direction: "desc" },
      ]),
    ).toEqual([
      { orderBy: "name", direction: "asc" },
      { orderBy: "createdAt", direction: "desc" },
    ]);
  });

  it("schema accepts only the stack form", () => {
    expect(
      sortPaginationCombo.safeParse({
        sort: { orderBy: "name", direction: "asc" },
      }).success,
    ).toBe(false);
    expect(
      createSortPaginationFields({
        sortableFields: ["name", "createdAt"],
        defaultSort: "name",
      }).sort.safeParse({ orderBy: "name", direction: "asc" }).success,
    ).toBe(false);

    const stacked = sortPaginationCombo.parse({
      sort: [
        { orderBy: "name", direction: "asc" },
        { orderBy: "createdAt", direction: "desc" },
      ],
    });
    expect(stacked.sort).toHaveLength(2);
    expect(sortPaginationCombo.parse({}).sort).toEqual([
      { orderBy: "createdAt", direction: "desc" },
    ]);
  });

  it("caps the stack at MAX_SORTS", () => {
    const sorts = ["a", "b", "c", "d", "e"].map((orderBy) => ({
      orderBy,
      direction: "asc" as const,
    }));
    const result = normalizeSorts(sorts);
    expect(result).toHaveLength(MAX_SORTS);
    expect(result.map((s) => s.orderBy)).toEqual(["a", "b", "c"]);
  });
});

it("preserves paginated transforms once and annotates invalid record errors", () => {
  const schema = createPaginatedResponseSchemaWithContext(
    z.object({
      name: z.string(),
      value: z
        .number()
        .transform((value) => value + 1)
        .pipe(z.number()),
    }),
    "fixture",
  );
  const meta = { pageIndex: 0, pageSize: 10, totalCount: 1 };
  expect(
    schema.parse({ meta, items: [{ name: "Record", value: 1 }] }).items[0]
      ?.value,
  ).toBe(2);
  const invalid = schema.safeParse({
    meta,
    items: [{ name: "Record", value: "bad" }],
  });
  expect(invalid.success).toBe(false);
  expect(invalid.error?.issues[0]?.message).toContain("fixture");
  expect(invalid.error?.issues[0]?.message).toContain(
    "Invalid input: expected number",
  );
  expect(invalid.error?.issues[0]?.path).toEqual(["items", 0, "value"]);
});
