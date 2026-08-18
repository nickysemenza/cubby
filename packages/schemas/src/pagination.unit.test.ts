import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  entityFilter,
  entityFilterList,
  MAX_SORTS,
  normalizeSorts,
  sortPaginationCombo,
} from "./pagination";

describe("exact entity filters", () => {
  const shortcode = z.string().regex(/^PRD-[A-Z2-9]{4}$/);

  it("maps invalid filter input without weakening the entity schema", () => {
    expect(entityFilter(shortcode).parse("PRD-4K7M")).toBe("PRD-4K7M");
    expect(entityFilter(shortcode).parse(UNRESOLVABLE_ENTITY_FILTER)).toBe(
      UNRESOLVABLE_ENTITY_FILTER,
    );
    expect(entityFilter(shortcode).parse("Milwaukee drill")).toBe(
      UNRESOLVABLE_ENTITY_FILTER,
    );
    expect(shortcode.safeParse("Milwaukee drill").success).toBe(false);
  });

  it("maps an invalid one-or-many value to the same fallback", () => {
    expect(entityFilterList(shortcode).parse(["PRD-4K7M", "PRD-2ABC"])).toEqual(
      ["PRD-4K7M", "PRD-2ABC"],
    );
    expect(
      entityFilterList(shortcode).parse(["PRD-4K7M", "Milwaukee drill"]),
    ).toBe(UNRESOLVABLE_ENTITY_FILTER);
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
