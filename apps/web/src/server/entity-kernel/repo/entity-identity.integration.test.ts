import { imageId } from "@cubby/schemas/identifiers";
import { generateShortcode, parseShortcodeFor } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import {
  device,
  entityIdentity,
  product as productTable,
  run,
} from "~/server/db/schema";
import { upsertDeviceFromHello } from "~/server/domains/device/repo/device-participation";
import {
  createUploadedImageRecord,
  deleteImages,
} from "~/server/domains/image/repo/image";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getAuditLog } from "~/server/generic/audit-log/repo/audit-log";
import { removeEntity } from "~/server/generic/removal/repo/entity";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failure modes without payload identity triggers: removes lose their
// tombstones, hard-deleted codes are reissued, and merges violate the deleted
// identity check or stop resolving older redirects.
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

  it("creates matching identities through Run admission and native Device hello", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const [createdRun] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    expect(await identityOf(createdRun!.shortcode)).toMatchObject({
      id: runId,
      kind: "run",
      deletedAt: null,
    });

    const installationId = crypto.randomUUID();
    await upsertDeviceFromHello(ctx.db, {
      installationId,
      name: "Synthetic native device",
      platform: "macos",
      appVersion: "1.0",
      osVersion: "1.0",
      automaticWork: false,
    });
    const [createdDevice] = await getDb(ctx.db)
      .select()
      .from(device)
      .where(eq(device.installationId, installationId));
    expect(await identityOf(createdDevice!.shortcode)).toMatchObject({
      id: createdDevice!.id,
      kind: "device",
      deletedAt: null,
    });
  });

  it("rolls back a removal and its identity tombstone together", async () => {
    const product = await seedProduct("Aborted identity removal");
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await removeEntity(tx, {
          entity: "product",
          ids: [product.entityId],
          removal: "soft",
          actor: ctx.actor,
        });
        throw new Error("Synthetic removal rollback");
      }),
    ).rejects.toThrow("Synthetic removal rollback");
    expect(await identityOf(product.id)).toMatchObject({ deletedAt: null });
    const [payload] = await getDb(ctx.db)
      .select()
      .from(productTable)
      .where(eq(productTable.id, product.entityId));
    expect(payload?.deletedAt).toBeNull();
  });

  it("preserves identity tombstones through supported soft and hard removal", async () => {
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
    await deleteImages(ctx.db, [imageId.parse(image.id)]);
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
    await deleteImages(ctx.db, [imageId.parse(image.id)]);
    let first = true;
    const replacement = await insertWithShortcode(
      ctx.db,
      "image",
      {
        key: "identity/reused.jpg",
        filename: "reused.jpg",
        contentType: "image/jpeg",
        size: 10,
        status: "UPLOADED",
      },
      {
        generate(entity) {
          if (first) {
            first = false;
            return parseShortcodeFor(entity, image.shortcode);
          }
          return generateShortcode(entity);
        },
      },
    );
    expect(replacement.shortcode).not.toBe(image.shortcode);
    expect(await identityOf(image.shortcode)).toMatchObject({
      deletedAt: expect.any(Date),
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

  it("refuses an attachment whose entityKind disagrees with its Entity row", async () => {
    const product = await seedProduct("Mislabelled attachment subject");
    const image = await createUploadedImageRecord(ctx.db, {
      key: "identity/mislabelled.jpg",
      filename: "mislabelled.jpg",
      contentType: "image/jpeg",
      size: 10,
    });
    const productEntityId = (await identityOf(product.id))?.id;
    await expect(
      getDb(ctx.db).execute(
        sql`INSERT INTO "EntityAttachment" ("entityId", "entityKind", "imageId")
            VALUES (${productEntityId}, 'location', ${image.id})`,
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "EntityAttachment_entity_fk" },
    });
  });

  it("refuses reads and writes through a merged-away code", async () => {
    const keeper = await seedProduct("Redirect keeper");
    const loser = await seedProduct("Redirect loser");
    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    await expect(getProduct(loser.id)).rejects.toThrow(
      `was merged into ${keeper.id}`,
    );

    const canonical = await getProduct(keeper.id);
    if (canonical.action !== "get") throw new Error("Expected product detail");
    expect(canonical.item).toMatchObject({ id: keeper.id });

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
      entityKind: "product",
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
