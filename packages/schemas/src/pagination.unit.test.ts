import { describe, expect, it } from "vitest";
import { MAX_SORTS, normalizeSorts, sortPaginationCombo } from "./pagination";

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
