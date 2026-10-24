import { locationId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, expectTypeOf, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { updateManyAndReturn } from "~/server/db/helpers/crud";
import { location } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

describe("keyed updates", () => {
  const ctx = withTestDb();

  it("preserves omitted columns, SQL expressions, native types and input order", async () => {
    const first = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic bulk first",
      type: "room",
      parentId: TEST_HOME_ID,
      notes: "retained",
    });
    const second = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic bulk second",
      type: "room",
      parentId: TEST_HOME_ID,
      notes: "old",
    });
    const third = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic bulk third",
      type: "room",
      parentId: TEST_HOME_ID,
    });
    const at = new Date("2026-09-01T12:00:00Z");
    const changed = await withTransaction(ctx.db, (tx) =>
      updateManyAndReturn(tx, location, {
        key: "shortcode",
        returning: [
          "shortcode",
          "notes",
          "tags",
          "lastBulkInventory",
          "parentId",
          "updatedAt",
        ],
        changes: [
          {
            keyValue: second.shortcode,
            patch: { notes: null, tags: ["second"], lastBulkInventory: at },
          },
          {
            keyValue: third.shortcode,
            patch: {
              notes: sql`'computed'`,
              tags: ["third"],
              lastBulkInventory: null,
            },
          },
          {
            keyValue: first.shortcode,
            patch: { tags: ["first"], notes: undefined },
          },
          { keyValue: "LOC-synthetic-missing", patch: { notes: "absent" } },
          { keyValue: "LOC-synthetic-empty", patch: { notes: undefined } },
        ],
      }),
    );
    expect(changed.map((row) => row.shortcode)).toEqual([
      second.shortcode,
      third.shortcode,
      first.shortcode,
    ]);
    expect(changed[0]).toMatchObject({
      notes: null,
      tags: ["second"],
      lastBulkInventory: at,
      parentId: TEST_HOME_ID,
    });
    expect(changed[1]).toMatchObject({
      notes: "computed",
      tags: ["third"],
      lastBulkInventory: null,
    });
    expect(changed[2]).toMatchObject({ notes: "retained", tags: ["first"] });
    expect(changed.every((row) => row.updatedAt instanceof Date)).toBe(true);
    const unchanged = await updateManyAndReturn(ctx.db, location, {
      key: "id",
      returning: ["id"],
      changes: [{ keyValue: first.id, patch: {} }],
    });
    expectTypeOf(unchanged).toEqualTypeOf<
      Pick<typeof location.$inferSelect, "id">[]
    >();
    expectTypeOf(changed).toEqualTypeOf<
      Pick<
        typeof location.$inferSelect,
        | "shortcode"
        | "notes"
        | "tags"
        | "lastBulkInventory"
        | "parentId"
        | "updatedAt"
      >[]
    >();
    expect(unchanged).toEqual([]);
  });

  it("rejects duplicate keys before applying any patch", async () => {
    const row = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic duplicate guard",
      type: "room",
      parentId: TEST_HOME_ID,
    });
    await expect(
      updateManyAndReturn(ctx.db, location, {
        key: "id",
        returning: ["id", "notes"],
        changes: [
          { keyValue: row.id, patch: { notes: "must not persist" } },
          { keyValue: row.id, patch: {} },
        ],
      }),
    ).rejects.toThrow("Duplicate bulk update key");
    expect(
      await getDb(ctx.db)
        .select({ notes: location.notes })
        .from(location)
        .where(eq(location.id, row.id)),
    ).toEqual([{ notes: null }]);
  });
  it("correlates UUID casing and rejects equivalent duplicate keys before writes", async () => {
    const row = await insertWithShortcode(ctx.db, "location", {
      id: locationId.parse("abcdefab-1234-4234-9234-abcdefabcdef"),
      name: "Synthetic UUID identity",
      type: "room",
      parentId: TEST_HOME_ID,
    });
    const upper = locationId.parse(row.id.toUpperCase());
    expect(
      await updateManyAndReturn(ctx.db, location, {
        key: "id",
        returning: ["id", "notes"],
        changes: [{ keyValue: upper, patch: { notes: "retained" } }],
      }),
    ).toMatchObject([{ id: row.id, notes: "retained" }]);
    await expect(
      updateManyAndReturn(ctx.db, location, {
        key: "id",
        returning: ["id", "notes"],
        changes: [
          { keyValue: upper, patch: { notes: "must not persist" } },
          { keyValue: row.id, patch: { tags: ["must not persist"] } },
        ],
      }),
    ).rejects.toThrow("Duplicate bulk update key");
    expect(
      await getDb(ctx.db)
        .select({ notes: location.notes, tags: location.tags })
        .from(location)
        .where(eq(location.id, row.id)),
    ).toEqual([{ notes: "retained", tags: [] }]);
  });

  it("bounds nested parameterized expressions and rejects an oversized patch before writing", async () => {
    const row = await insertWithShortcode(ctx.db, "location", {
      name: "Synthetic expression budget",
      type: "room",
      parentId: TEST_HOME_ID,
    });
    const changes = Array.from({ length: 128 }, (_, index) => ({
      keyValue: index === 0 ? row.shortcode : `LOC-synthetic-missing-${index}`,
      patch: {
        tags: sql`ARRAY[${sql.join(
          Array.from(
            { length: 600 },
            (_, value) => sql`${`${index}:${value}`}`,
          ),
          sql`, `,
        )}]::text[]`,
      },
    }));
    expect(
      await updateManyAndReturn(ctx.db, location, {
        key: "shortcode",
        returning: ["shortcode", "id", "tags"],
        changes,
      }),
    ).toMatchObject([
      { id: row.id, tags: expect.arrayContaining(["0:0", "0:599"]) },
    ]);
    await expect(
      updateManyAndReturn(ctx.db, location, {
        key: "shortcode",
        returning: ["shortcode", "id", "tags"],
        changes: [
          { keyValue: row.shortcode, patch: { notes: "must not persist" } },
          {
            keyValue: "LOC-synthetic-oversized",
            patch: {
              tags: sql`ARRAY[${sql.join(
                Array.from(
                  { length: 30001 },
                  (_, value) => sql`${String(value)}`,
                ),
                sql`, `,
              )}]::text[]`,
            },
          },
        ],
      }),
    ).rejects.toThrow("Individual bulk update exceeds parameter budget");
    expect(
      await getDb(ctx.db)
        .select({ notes: location.notes })
        .from(location)
        .where(eq(location.id, row.id)),
    ).toEqual([{ notes: null }]);
  });
});
