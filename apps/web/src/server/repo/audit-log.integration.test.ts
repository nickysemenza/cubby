import { randomUUID } from "node:crypto";

import type { AuditEntityType } from "@cubby/schemas/audit";
import type { AuditChannel } from "@cubby/schemas/context";
import { testShortcode } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { auditLog, product } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { listAuditLog } from "~/server/workflows/audit-log";

import { insertAndReturn, withTransaction } from "./database-helpers";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

/**
 * `getAuditLog` filters by `channel` and a `createdAtFrom`/
 * `createdAtTo` window on top of the existing entityType/entityId/cursor
 * filters. Rows are inserted directly against the `auditLog` table (rather
 * than through `logAuditEntry`) so each test can pin an exact `createdAt` —
 * `logAuditEntry` always stamps `defaultNow()`.
 */
describe("getAuditLog — channel + time window", () => {
  const ctx = withTestDb();

  it("routes unknown and mismatched public audit subjects to an empty result", async () => {
    const record = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audit subject fixture" }),
      ctx.actor,
    );
    const listed = await listAuditLog({
      db: ctx.db,
      data: { entityType: "product", entityId: record.id, limit: 50 },
    });
    expect(listed.entries.length).toBeGreaterThan(0);
    expect(
      await listAuditLog({
        db: ctx.db,
        data: { entityType: "ingredient", entityId: record.id, limit: 50 },
      }),
    ).toEqual({ entries: [] });
    expect(
      await listAuditLog({
        db: ctx.db,
        data: {
          entityId: testShortcode("product", "missing-audit-subject"),
          limit: 50,
        },
      }),
    ).toEqual({ entries: [] });
  });

  // Audit rows reference a real identity (ADR 0006), so each names a product.
  const makeEntry = async (overrides: {
    createdAt: Date;
    channel?: AuditChannel;
  }) => {
    const subject = await insertWithShortcode(ctx.db, "product", {
      name: `Audit subject ${randomUUID()}`,
      manufacturer: "Test Mfr",
    });
    return insertAndReturn(ctx.db, auditLog, {
      entityType: "product",
      entityId: subject.id,
      action: "update",
      userId: ctx.actor.userId,
      channel: overrides.channel ?? "web",
      createdAt: overrides.createdAt,
    });
  };

  const day1 = new Date("2026-07-01T00:00:00.000Z");
  const day2 = new Date("2026-07-15T00:00:00.000Z");
  const day3 = new Date("2026-07-30T00:00:00.000Z");

  it("includes rows on both window boundaries and excludes rows outside it", async () => {
    await makeEntry({ createdAt: day1 });
    await makeEntry({ createdAt: day2 });
    await makeEntry({ createdAt: day3 });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      createdAtFrom: day1.toISOString(),
      createdAtTo: day2.toISOString(),
    });

    expect(entries).toHaveLength(2);
    const returnedTimes = entries.map((e) => e.createdAt.toISOString()).sort();
    expect(returnedTimes).toEqual([day1.toISOString(), day2.toISOString()]);
  });

  it("paginates identical timestamps without repeating or skipping entries", async () => {
    const timestamp = new Date("2026-07-20T12:00:00.000Z");
    const channel = "system";
    await Promise.all(
      Array.from({ length: 7 }, () =>
        makeEntry({ createdAt: timestamp, channel }),
      ),
    );

    const entryKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAuditLog(ctx.db, {
        limit: 2,
        channel,
        cursor,
      });
      entryKeys.push(...page.entries.map((entry) => entry.entryKey));
      cursor = page.nextCursor;
    } while (cursor);

    expect(entryKeys).toHaveLength(7);
    expect(new Set(entryKeys).size).toBe(7);
  });
});

/**
 * The home feed renders one line per entry, so an entry that resolves to a
 * bare type + shortcode ("Inventory Item INV-KZYZ") carries no information.
 * `entityName` is resolved at read time — from a display column for most
 * entities, and from a product+location join for inventory, whose identity is
 * relational. These pin each outcome that resolution can produce.
 */
describe("getAuditLog — entityName", () => {
  const ctx = withTestDb();

  const auditRowFor = (entityType: AuditEntityType, entityId: string) =>
    insertAndReturn(ctx.db, auditLog, {
      entityType,
      entityId,
      action: "update",
      userId: ctx.actor.userId,
    });

  it("still names a row that was soft-deleted after the entry was written", async () => {
    const row = await insertWithShortcode(ctx.db, "product", {
      name: "Retired Blade",
      manufacturer: "ACME",
    });
    await auditRowFor("product", row.id);
    await withTransaction(ctx.db, (tx) =>
      tx
        .update(product)
        .set({ deletedAt: new Date() })
        .where(eq(product.id, row.id)),
    );

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityType: "product",
    });
    expect(entries[0]?.entityName).toBe("Retired Blade");
  });

  it("names an inventory entry compositely, by its product and location", async () => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Garage" }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Cast Iron Skillet" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: loc.id,
        amount: { value: 1, unit: "ea" },
      },
      ctx.actor,
    );
    await auditRowFor("inventory", entry.entityId);

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityType: "inventory",
    });
    expect(entries[0]?.entityName).toBe("Cast Iron Skillet · Garage");
  });
});
