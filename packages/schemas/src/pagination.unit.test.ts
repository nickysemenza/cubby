import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  createPaginatedResponseSchemaWithContext,
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
  const shortcode = z.string().regex(/^PRD-[A-Z2-9]{4}$/);

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
  it("wraps a single sort object into a one-element array", () => {
    expect(normalizeSorts({ orderBy: "name", direction: "asc" })).toEqual([
      { orderBy: "name", direction: "asc" },
    ]);
  });

  it("passes a stacked sort through in order", () => {
    expect(
      normalizeSorts([
        { orderBy: "location", direction: "asc" },
        { orderBy: "price", direction: "desc" },
      ]),
    ).toEqual([
      { orderBy: "location", direction: "asc" },
      { orderBy: "price", direction: "desc" },
    ]);
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

  it("schema accepts both the legacy single object (MCP shape) and an array", () => {
    const single = sortPaginationCombo.parse({
      sort: { orderBy: "name", direction: "asc" },
    });
    expect(single.sort).toEqual({ orderBy: "name", direction: "asc" });

    const stacked = sortPaginationCombo.parse({
      sort: [
        { orderBy: "name", direction: "asc" },
        { orderBy: "createdAt", direction: "desc" },
      ],
    });
    expect(Array.isArray(stacked.sort)).toBe(true);
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
