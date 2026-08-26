import { randomUUID } from "node:crypto";
import type { AuditEntityType } from "@cubby/schemas/audit";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";

import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { auditLog, product } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { insertAndReturn, withTransaction } from "./database-helpers";
import { updateProduct } from "./product";
import {
  createImageFixture,
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";

/**
 * `getAuditLog` (PR 6, Phase 6) gained `source` and a `createdAtFrom`/
 * `createdAtTo` window on top of the existing entityType/entityId/cursor
 * filters. Rows are inserted directly against the `auditLog` table (rather
 * than through `logAuditEntry`) so each test can pin an exact `createdAt` —
 * `logAuditEntry` always stamps `defaultNow()`.
 */
describe("getAuditLog — source + time window", () => {
  const ctx = withTestDb();

  const makeEntry = (overrides: {
    createdAt: Date;
    source?: string;
    entityType?: AuditEntityType;
  }) =>
    insertAndReturn(ctx.db, auditLog, {
      entityType: overrides.entityType ?? "product",
      entityId: randomUUID(),
      action: "update",
      userId: ctx.actor.userId,
      source: overrides.source ?? "ui",
      createdAt: overrides.createdAt,
    });

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

  it("filters by a single source", async () => {
    await makeEntry({ createdAt: day1, source: "ui" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({
      createdAt: day3,
      source: "script:home-depot-export-2026-07-28",
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: "api",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("api");
  });

  it("filters by an array of sources, including the open-ended script: family", async () => {
    await makeEntry({ createdAt: day1, source: "ui" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({
      createdAt: day3,
      source: "script:home-depot-export-2026-07-28",
    });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: ["api", "script:home-depot-export-2026-07-28"],
    });

    expect(entries.map((e) => e.source).sort()).toEqual(
      ["api", "script:home-depot-export-2026-07-28"].sort(),
    );
  });

  it("combines a source filter with cursor-based pagination (both AND together)", async () => {
    // Three "api"-sourced rows, oldest to newest, plus a "ui" row that must
    // never surface once the source filter is applied.
    await makeEntry({ createdAt: day1, source: "api" });
    await makeEntry({ createdAt: day2, source: "api" });
    await makeEntry({ createdAt: day3, source: "api" });
    await makeEntry({ createdAt: day3, source: "ui" });

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      source: "api",
      cursor: day3.toISOString(),
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.source === "api")).toBe(true);
    expect(entries.every((e) => e.createdAt.getTime() < day3.getTime())).toBe(
      true,
    );
  });

  it("paginates identical timestamps without repeating or skipping entries", async () => {
    const timestamp = new Date("2026-07-20T12:00:00.000Z");
    const source = "script:audit-cursor-boundary";
    await Promise.all(
      Array.from({ length: 7 }, () =>
        makeEntry({ createdAt: timestamp, source }),
      ),
    );

    const entryKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAuditLog(ctx.db, {
        limit: 2,
        source,
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
      source: "ui",
    });

  it("resolves the display name of an entity that has one", async () => {
    const cover = await createImageFixture(ctx.db, "audit-product-cover");
    const row = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Festool Track Saw Rail",
        manufacturer: "Festool",
      }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      parseEntityId("product", row.entityId),
      { pendingImageIds: [parseShortcodeFor("image", cover.shortcode)] },
      ctx.actor,
    );
    await auditRowFor("product", row.entityId);

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityType: "product",
    });
    expect(entries[0]?.entityName).toBe("Festool Track Saw Rail");
    expect(entries[0]?.displayImage).toEqual({ url: cover.url });
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

  it("returns null when the referenced row cannot be named", async () => {
    await auditRowFor("inventory", randomUUID());

    const { entries } = await getAuditLog(ctx.db, {
      limit: 50,
      entityType: "inventory",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityName).toBeNull();
  });
});
