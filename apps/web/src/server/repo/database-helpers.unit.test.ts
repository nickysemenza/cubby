import { asc } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Database, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  eqAnyOrPresence,
  formatSearchTerm,
  isTransaction,
  withTransactionOn,
} from "~/server/repo/database-helpers";

const dialect = new PgDialect();
const renderSql = (clauses: ReturnType<typeof buildOrderBy>) =>
  clauses.map((clause) => dialect.sqlToQuery(clause).sql);

/**
 * `Database` is opaque (declares no members), so the only structural signal that
 * separates it from a `DrizzleTransaction` is the latter's `rollback`. These
 * stand in for the two handles without a DB — the branch decision is pure.
 */
const fakeTx = { rollback: () => {} } as unknown as DrizzleTransaction;
const fakeDb = {} as Database;

describe("isTransaction", () => {
  it("recognizes an open transaction by its rollback method", () => {
    expect(isTransaction(fakeTx)).toBe(true);
  });

  it("does not treat the opaque Database handle as a transaction", () => {
    expect(isTransaction(fakeDb)).toBe(false);
  });
});

describe("withTransactionOn", () => {
  it("JOINS an open transaction — same handle, no new boundary", async () => {
    // The whole point of the helper: the callback must receive the caller's own
    // `tx`, not a fresh one. A new boundary here would be a different pooled
    // connection that cannot see the caller's uncommitted writes.
    let received: unknown;
    const out = await withTransactionOn(fakeTx, async (tx) => {
      received = tx;
      return "joined";
    });
    expect(received).toBe(fakeTx);
    expect(out).toBe("joined");
  });

  it("opens one when handed the pooled Database", async () => {
    // No real client here, so `getDb(db).transaction` is unreachable — asserting
    // it *tried* is enough to pin that this handle takes the open path rather
    // than being passed through as a transaction.
    await expect(
      withTransactionOn(fakeDb, async () => "unreachable"),
    ).rejects.toThrow();
  });
});

describe("formatSearchTerm", () => {
  it("should return undefined for undefined input", () => {
    expect(formatSearchTerm(product.name, undefined)).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(formatSearchTerm(product.name, "")).toBeUndefined();
  });

  it("should return undefined for whitespace only string", () => {
    expect(formatSearchTerm(product.name, "   ")).toBeUndefined();
  });

  it("should return ilike SQL condition for valid term", () => {
    const result = formatSearchTerm(product.name, "chicken");
    expect(result).toBeDefined();
    // The result is a SQL object from drizzle-orm, we just verify it's returned
    expect(result).toBeTruthy();
  });

  it("should handle multi-word terms", () => {
    const result = formatSearchTerm(product.name, "chicken breast");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should handle special characters", () => {
    const result = formatSearchTerm(product.name, "test@example.com");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should handle unicode characters", () => {
    const result = formatSearchTerm(product.name, "café résumé");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
  });

  it("should preserve whitespace in search term", () => {
    const result = formatSearchTerm(product.name, "  trimmed  ");
    expect(result).toBeDefined();
    expect(result).toBeTruthy();
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
        ["category", "name"],
        {
          groupBy: "category",
          resolve: (sort) =>
            sort.orderBy === "name" ? [asc(product.manufacturer)] : null,
          tieBreaker: asc(product.shortcode),
        },
      ),
    );

    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain('"Product"."category" asc nulls last');
    expect(sql.at(-1)).toContain('"Product"."id" asc');
  });
});

describe("eqAnyOrPresence", () => {
  it("returns undefined when value is empty/undefined and presence is unset (no constraint)", () => {
    expect(
      eqAnyOrPresence(product.category, undefined, undefined),
    ).toBeUndefined();
    expect(eqAnyOrPresence(product.category, [], undefined)).toBeUndefined();
  });

  it("falls back to eqAny's clause when presence is unset", () => {
    const result = eqAnyOrPresence(product.category, ["food"], undefined);
    expect(result).toBeDefined();
  });

  it("returns a presence-only clause when value is empty/undefined", () => {
    expect(eqAnyOrPresence(product.category, undefined, "none")).toBeDefined();
    expect(eqAnyOrPresence(product.category, [], "has")).toBeDefined();
  });

  it("ORs the value clause with the presence clause when both are set", () => {
    const none = eqAnyOrPresence(product.category, ["food"], "none");
    const has = eqAnyOrPresence(product.category, ["food"], "has");
    expect(none).toBeDefined();
    expect(has).toBeDefined();
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
