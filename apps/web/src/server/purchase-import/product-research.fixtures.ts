import type { ActorContext } from "@cubby/schemas/context";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  auditLog,
  entityExternalId,
  externalSource,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  product,
  vendor as vendorTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createProductFixture,
  insertEntityAttachments,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/** Source-owned purchased Product; no browsing account or Vendor website exists. */
export async function productResearchFixture(
  db: Database,
  actor: ActorContext,
  options: {
    legacy?: boolean;
    complete?: boolean;
    party?: typeof ledgerParty.$inferSelect;
    vendor?: typeof vendorTable.$inferSelect;
    orderId?: string;
  } = {},
) {
  const party =
    options.party ??
    (await insertWithShortcode(db, "ledgerParty", {
      name: "Example research owner",
      kind: "member",
      userId: actor.userId,
    }));
  const parent = await insertWithShortcode(db, "run", {
    purpose: options.legacy ? "account_sync" : "mail_import",
    trigger: "manual",
    status: "completed",
    ledgerPartyId: party.id,
    actorUserId: actor.userId,
    actorName: party.name,
    actorEmail: "research@example.test",
    actorLedgerPartyShortcode: party.shortcode,
    actorLedgerPartyName: party.name,
    actorLedgerPartyKind: "member",
  });
  const vendor =
    options.vendor ??
    (await insertWithShortcode(db, "vendor", {
      name: "Example offline seller",
      website: null,
    }));
  const order = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: options.orderId ?? "SYNTHETIC-ORDER",
    date: "2026-09-01",
  });
  const item = await createProductFixture(
    db,
    makeProductInput({
      name: "Example ordered small device",
      manufacturer: "Example Works",
      model: "Q-17",
    }),
    actor,
  );
  await insertWithShortcode(db, "expense", {
    name: "Small Q-17 device",
    purchaseId: order.id,
    productId: item.entityId,
    cost: 24,
    date: "2026-09-01",
    costType: "materials",
    trade: "other",
    productQuantity: 1,
  });
  let association: typeof importSourceOrder.$inferSelect | null = null;
  if (options.legacy) {
    await getDb(db)
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.entityId, item.entityId),
          eq(auditLog.action, "create"),
        ),
      );
    await getDb(db).insert(auditLog).values({
      entityKind: "purchase",
      entityId: order.id,
      action: "create",
      userId: actor.userId,
      runId: parent.id,
    });
  } else {
    const [source] = await getDb(db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: "synthetic-mail-receipt",
        checksum: "a".repeat(64),
        firstRunId: parent.id,
        lastRunId: parent.id,
      })
      .returning();
    if (!source) throw new Error("Synthetic source missing");
    const [row] = await getDb(db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: source.id,
        orderKey: "SYNTHETIC-ORDER",
        purchaseId: order.id,
        checksum: source.checksum,
        outputFingerprint: "b".repeat(64),
      })
      .returning();
    if (!row) throw new Error("Synthetic order association missing");
    association = row;
  }
  if (options.complete) {
    const category = await insertWithShortcode(db, "productCategory", {
      name: "Example devices",
    });
    await getDb(db)
      .update(product)
      .set({ categoryId: category.id })
      .where(eq(product.id, item.entityId));
    await getDb(db)
      .insert(externalSource)
      .values({ slug: "example-seller", label: "Example seller" });
    await getDb(db).insert(entityExternalId).values({
      entityKind: "product",
      entityId: item.entityId,
      source: "example-seller",
      kind: "retailer_sku",
      externalId: "SMALL-17",
      isPrimary: true,
    });
    const photo = await createImageFixture(db, "research-filled-cover", {
      source: "own",
    });
    await insertEntityAttachments(db, {
      entityId: item.entityId,
      imageId: photo.id,
      purpose: "item",
      sortOrder: 0,
    });
  }
  return { party, parent, order, item, association };
}
