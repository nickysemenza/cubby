import { asc } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
} from "~/server/repo/database-helpers";

const dialect = new PgDialect();
const renderSql = (clauses: ReturnType<typeof buildOrderBy>) =>
  clauses.map((clause) => dialect.sqlToQuery(clause).sql);

describe("executeListQueryWithCount", () => {
  it("does not construct the row query for a count read", async () => {
    let rowQueryConstructed = false;
    const result = await executeListQueryWithCount({
      kind: "count",
      rows: async () => {
        rowQueryConstructed = true;
        return [1];
      },
      count: async () => 7,
    });

    expect(result).toEqual({ data: [], count: 7 });
    expect(rowQueryConstructed).toBe(false);
  });

  it("constructs both lazy queries for a page read", async () => {
    const constructed: string[] = [];
    const result = await executeListQueryWithCount({
      kind: "page",
      rows: async () => {
        constructed.push("rows");
        return [1, 2];
      },
      count: async () => {
        constructed.push("count");
        return 7;
      },
    });

    expect(result).toEqual({ data: [1, 2], count: 7 });
    expect(constructed).toEqual(expect.arrayContaining(["rows", "count"]));
  });
});

describe("formatSearchTerm", () => {
  it("should return undefined for undefined, empty, or whitespace-only input", () => {
    expect(formatSearchTerm(product.name, undefined)).toBeUndefined();
    expect(formatSearchTerm(product.name, "")).toBeUndefined();
    expect(formatSearchTerm(product.name, "   ")).toBeUndefined();
  });

  it("wraps the term in an ilike pattern without trimming it", () => {
    const result = formatSearchTerm(product.name, "  trimmed  ");
    expect(result && dialect.sqlToQuery(result).sql).toBe(
      `"Product"."name" ilike $1`,
    );
    expect(result && dialect.sqlToQuery(result).params).toEqual([
      "%  trimmed  %",
    ]);
  });
});

describe("buildOrderBy", () => {
  it("always appends the unique id after the visible sort stack", () => {
    const sql = renderSql(
      buildOrderBy(
        product,
        [
          { orderBy: "name", direction: "asc" },
          { orderBy: "createdAt", direction: "desc" },
        ],
        ["name", "createdAt"],
      ),
    );

    expect(sql).toHaveLength(3);
    expect(sql.at(-1)).toContain('"Product"."id" asc');
  });

  it("puts group, resolver, and cosmetic tie-breakers before the unique id", () => {
    const sql = renderSql(
      buildOrderBy(
        product,
        [{ orderBy: "name", direction: "asc" }],
        ["categoryId", "name"],
        {
          groupBy: "categoryId",
          resolve: (sort) =>
            sort.orderBy === "name" ? [asc(product.manufacturer)] : null,
          tieBreaker: asc(product.shortcode),
        },
      ),
    );

    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain('"Product"."categoryId" asc nulls last');
    expect(sql.at(-1)).toContain('"Product"."id" asc');
  });

  it("promotes a later group-field sort ahead of the other sorts", () => {
    const clauses = renderSql(
      buildOrderBy(
        product,
        [
          { orderBy: "name", direction: "asc" },
          { orderBy: "categoryId", direction: "desc" },
        ],
        ["name", "categoryId"],
        { groupBy: "categoryId" },
      ),
    );
    expect(clauses).toHaveLength(3);
    expect(clauses[0]).toContain('"Product"."categoryId" desc nulls last');
    expect(clauses[1]).toContain('"Product"."name" asc');
  });
});

describe("eqAnyOrPresence", () => {
  it("returns undefined when value is empty/undefined and presence is unset (no constraint)", () => {
    expect(
      eqAnyOrPresence(product.categoryId, undefined, undefined),
    ).toBeUndefined();
    expect(eqAnyOrPresence(product.categoryId, [], undefined)).toBeUndefined();
  });

  it("ORs the value clause with the presence clause: a picked value plus (none) widens, it never ANDs into a contradiction", () => {
    const result = eqAnyOrPresence(
      product.categoryId,
      ["food", "produce"],
      "none",
    );
    expect(result && dialect.sqlToQuery(result).sql).toBe(
      `("Product"."categoryId" in ($1, $2) or "Product"."categoryId" is null)`,
    );
    expect(result && dialect.sqlToQuery(result).params).toEqual([
      "food",
      "produce",
    ]);
  });
});

describe("buildPartialUpdateValues", () => {
  it("should return empty object for empty input", () => {
    const result = buildPartialUpdateValues({});
    expect(result).toEqual({});
  });

  it("should filter out undefined values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      description: undefined,
      type: "product",
    });
    expect(result).toEqual({
      name: "test",
      type: "product",
    });
  });

  it("should keep null values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      parentId: null,
    });
    expect(result).toEqual({
      name: "test",
      parentId: null,
    });
  });

  it("should keep empty string values", () => {
    const result = buildPartialUpdateValues({
      name: "",
      description: undefined,
    });
    expect(result).toEqual({
      name: "",
    });
  });

  it("should keep zero values", () => {
    const result = buildPartialUpdateValues({
      quantity: 0,
      price: undefined,
    });
    expect(result).toEqual({
      quantity: 0,
    });
  });

  it("should keep false boolean values", () => {
    const result = buildPartialUpdateValues({
      isActive: false,
      isDeleted: undefined,
    });
    expect(result).toEqual({
      isActive: false,
    });
  });

  it("should handle all undefined values", () => {
    const result = buildPartialUpdateValues({
      name: undefined,
      type: undefined,
      description: undefined,
    });
    expect(result).toEqual({});
  });

  it("should handle all defined values", () => {
    const result = buildPartialUpdateValues({
      name: "test",
      type: "product",
      quantity: 5,
    });
    expect(result).toEqual({
      name: "test",
      type: "product",
      quantity: 5,
    });
  });

  it("should handle nested objects", () => {
    const nestedObj = { foo: "bar" };
    const result = buildPartialUpdateValues({
      config: nestedObj,
      other: undefined,
    });
    expect(result).toEqual({
      config: nestedObj,
    });
  });

  it("should handle arrays", () => {
    const arr = [1, 2, 3];
    const result = buildPartialUpdateValues({
      items: arr,
      tags: undefined,
    });
    expect(result).toEqual({
      items: arr,
    });
  });
});
