import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityIdentity } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getAuditLog } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { createUploadedImageRecord } from "~/server/repo/image";
import { mergeProducts } from "~/server/repo/product";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("durable entity identity", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  const identityOf = async (shortcode: string) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(entityIdentity)
      .where(eq(entityIdentity.shortcode, shortcode));
    return row;
  };

  const seedProduct = (name: string) =>
    createProductFixture(ctx.db, makeProductInput({ name }), ctx.actor);

  const getProduct = (id: string) =>
    executeEntity(context(), {
      action: "get",
      entity: "product",
      id,
      missing: "error",
    });

  it("binds every shortcode table to Entity with an FK and all three triggers", async () => {
    const { rows } = await getDb(ctx.db).execute<{
      table: string;
      fks: number;
      triggers: number;
    }>(sql`
      SELECT c.relname AS "table",
        (SELECT count(*)::int FROM pg_constraint k
          WHERE k.conrelid = c.oid AND k.conname LIKE '%\\_entity\\_identity\\_fk') AS "fks",
        (SELECT count(*)::int FROM pg_trigger t
          WHERE t.tgrelid = c.oid AND t.tgname LIKE 'Entity\\_identity\\_%') AS "triggers"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_trigger t
          WHERE t.tgrelid = c.oid AND t.tgname LIKE 'Entity\\_identity\\_%')
    `);
    expect(rows).toHaveLength(shortcodeEntities.length);
    expect(rows.filter((row) => row.fks !== 1 || row.triggers !== 3)).toEqual(
      [],
    );
  });

  it("mirrors create, soft delete, and hard delete onto the identity row", async () => {
    const product = await seedProduct("Identity mirror");
    expect(await identityOf(product.id)).toMatchObject({
      kind: "product",
      deletedAt: null,
      mergedIntoId: null,
    });

    await executeEntity(context(), {
      action: "delete",
      entity: "product",
      ids: [product.id],
    });
    expect((await identityOf(product.id))?.deletedAt).toBeInstanceOf(Date);

    const image = await createUploadedImageRecord(ctx.db, {
      key: "identity/hard-delete.jpg",
      filename: "hard-delete.jpg",
      contentType: "image/jpeg",
      size: 10,
    });
    await getDb(ctx.db).execute(
      sql`DELETE FROM "Image" WHERE "shortcode" = ${image.shortcode}`,
    );
    // The payload is gone; its identity survives as a tombstone.
    expect(await identityOf(image.shortcode)).toMatchObject({
      kind: "image",
      deletedAt: expect.any(Date),
    });
  });

  it("never reuses a hard-deleted code and never lets a payload rename its code", async () => {
    const image = await createUploadedImageRecord(ctx.db, {
      key: "identity/reuse.jpg",
      filename: "reuse.jpg",
      contentType: "image/jpeg",
      size: 10,
    });
    await getDb(ctx.db).execute(
      sql`DELETE FROM "Image" WHERE "shortcode" = ${image.shortcode}`,
    );
    await expect(
      getDb(ctx.db).execute(
        sql`INSERT INTO "Image" ("shortcode", "key", "filename", "contentType", "size", "status")
            VALUES (${image.shortcode}, 'identity/reused.jpg', 'reused.jpg', 'image/jpeg', 10, 'UPLOADED')`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "Entity_shortcode_unique" },
    });

    const product = await seedProduct("Fixed code");
    await expect(
      getDb(ctx.db).execute(
        sql`UPDATE "Product" SET "shortcode" = 'PRD-ZZZZ' WHERE "shortcode" = ${product.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "Product_entity_identity_fk" },
    });
  });

  it("redirects reads of a merged-away code and refuses writes through it", async () => {
    const keeper = await seedProduct("Redirect keeper");
    const loser = await seedProduct("Redirect loser");
    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    const read = await getProduct(loser.id);
    if (read.action !== "get") throw new Error("Expected product detail");
    expect(read.item).toMatchObject({
      id: keeper.id,
      redirectedFrom: loser.id,
      previousShortcodes: [loser.id],
    });

    const canonical = await getProduct(keeper.id);
    if (canonical.action !== "get") throw new Error("Expected product detail");
    expect(canonical.item).toMatchObject({ redirectedFrom: null });

    await expect(
      executeEntity(context(), {
        action: "update",
        entity: "product",
        id: loser.id,
        data: { notes: "through the old code" },
      }),
    ).rejects.toThrow(`was merged into ${keeper.id}`);

    // History keeps the identity that received each event and adds the
    // survivor as a read-time projection.
    const loserId = (await identityOf(loser.id))?.id;
    const { entries } = await getAuditLog(ctx.db, {
      entityType: "product",
      entityId: loserId,
      limit: 50,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        entityId: loser.id,
        canonicalEntityId: keeper.id,
      });
    }
  });

  it("path-compresses redirects and refuses re-merging an absorbed code", async () => {
    const first = await seedProduct("Chain first");
    const second = await seedProduct("Chain second");
    const third = await seedProduct("Chain third");
    await mergeProducts(
      ctx.db,
      { keepId: second.id, mergeIds: [first.id] },
      ctx.actor,
    );
    await mergeProducts(
      ctx.db,
      { keepId: third.id, mergeIds: [second.id] },
      ctx.actor,
    );
    const thirdId = await resolveLiveShortcode(ctx.db, third.id, "product");
    // Every redirect is one hop, straight to the live survivor.
    expect((await identityOf(first.id))?.mergedIntoId).toBe(thirdId);
    expect((await identityOf(second.id))?.mergedIntoId).toBe(thirdId);

    // Regression: merging an absorbed code back into its survivor resolved to
    // a self-merge before identity existed.
    await expect(
      mergeProducts(
        ctx.db,
        { keepId: third.id, mergeIds: [first.id] },
        ctx.actor,
      ),
    ).rejects.toThrow(`was merged into ${third.id}`);
  });

  it("reports a tombstone when a merge survivor is deleted later", async () => {
    const keeper = await seedProduct("Deleted keeper");
    const loser = await seedProduct("Deleted keeper's loser");
    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );
    await executeEntity(context(), {
      action: "delete",
      entity: "product",
      ids: [keeper.id],
    });

    await expect(getProduct(loser.id)).rejects.toThrow(
      `was merged into ${keeper.id}, which was deleted`,
    );
    await expect(getProduct(keeper.id)).rejects.toThrow(
      `${keeper.id} — it was deleted`,
    );
  });
});
