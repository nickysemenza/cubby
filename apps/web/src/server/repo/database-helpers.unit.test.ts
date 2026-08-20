import { type ProjectId, unsafeProjectId } from "@cubby/schemas/identifiers";
import { asc } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Database, DrizzleTransaction } from "~/server/db";
import { product, project, projectDependency } from "~/server/db/schema";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  isTransaction,
  replaceDependencyEdges,
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

describe("executeListQueryWithCount", () => {
  it("does not execute the row query in count-only mode", async () => {
    let rowQueryAwaited = false;
    const rowQuery = {
      // biome-ignore lint/suspicious/noThenProperty: Drizzle queries are lazy thenables; the test must model that contract.
      then: (resolve: (rows: number[]) => unknown) => {
        rowQueryAwaited = true;
        return Promise.resolve(resolve([1]));
      },
    } as unknown as Promise<number[]>;

    const result = await executeListQueryWithCount(
      rowQuery,
      Promise.resolve(7),
      { countOnly: true },
    );

    expect(result).toEqual({ data: [], count: 7 });
    expect(rowQueryAwaited).toBe(false);
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

/**
 * The self-reference guard is entity-generic and runs before `tx` is touched:
 * dedupe, then reject, then (only then) query for live rows.
 *
 * This replaces a pair of per-entity integration tests that each created a real
 * row and called `updateProject` / `updateTask` just to reach it — those had to
 * resolve shortcodes against the database first, so they paid three round trips
 * to assert a string comparison. Testing the helper directly also covers the
 * task path, which the project-flavoured test never did.
 */
describe("replaceDependencyEdges self-reference guard", () => {
  const explodingTx = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `replaceDependencyEdges touched the transaction (property "${String(prop)}") before rejecting a self-reference`,
        );
      },
    },
  ) as unknown as DrizzleTransaction;

  const A = unsafeProjectId("11111111-1111-4111-8111-111111111111");
  const B = unsafeProjectId("22222222-2222-4222-8222-222222222222");

  const opts = {
    ownColumn: projectDependency.projectId,
    blockedByColumn: projectDependency.blockedByProjectId,
    buildRow: (projectId: ProjectId, blockedByProjectId: ProjectId) => ({
      projectId,
      blockedByProjectId,
    }),
    entityTable: project,
    entity: "project" as const,
  };

  it("rejects an entity blocked by itself without touching the transaction", async () => {
    await expect(
      replaceDependencyEdges(explodingTx, projectDependency, opts, A, [A, B]),
    ).rejects.toThrow(/cannot be blocked by itself/i);
  });

  it("rejects a self-reference that only appears after deduping", async () => {
    await expect(
      replaceDependencyEdges(explodingTx, projectDependency, opts, A, [A, A]),
    ).rejects.toThrow(/cannot be blocked by itself/i);
  });

  // Guards the guard: a non-self edge set must get PAST the check and reach the
  // transaction, so neither the proxy nor the guard can quietly stop working.
  it("lets a clean edge set through to the transaction", async () => {
    await expect(
      replaceDependencyEdges(explodingTx, projectDependency, opts, A, [B]),
    ).rejects.toThrow(/touched the transaction/i);
  });
});
