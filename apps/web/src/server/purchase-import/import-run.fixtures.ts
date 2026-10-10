import type { ActorContext } from "@cubby/schemas/context";
import {
  runEntityId,
  type LedgerPartyId,
  type VendorAccountId,
} from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import type { RunTrigger } from "@cubby/schemas/purchase-import";
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
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createProductFixture,
  insertEntityAttachments,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { actorSnapshot } from "~/server/runs/ensure-run";

/**
 * A member's running import Run for one Vendor account: what a member's own
 * `purchase_import.prepare` opens, pinned to an account so writer tests can
 * exercise account-scoped Purchases and settlement.
 */
export async function startImportRunFixture(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorAccountId: VendorAccountId;
    trigger?: RunTrigger;
  },
) {
  const [account] = await getDb(db)
    .select({ vendorId: vendorAccount.vendorId, userId: ledgerParty.userId })
    .from(vendorAccount)
    .innerJoin(ledgerParty, eq(ledgerParty.id, vendorAccount.ledgerPartyId))
    .where(
      and(
        eq(vendorAccount.id, input.vendorAccountId),
        eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
      ),
    )
    .limit(1);
  if (!account?.userId)
    throw new Error("Import fixture account has no member owner");
  const snapshot = await actorSnapshot(getDb(db), account.userId);
  const row = await insertWithShortcode(db, "run", {
    id: runEntityId.parse(crypto.randomUUID()),
    ledgerPartyId: input.ledgerPartyId,
    actorUserId: account.userId,
    actorName: snapshot.actorName,
    actorEmail: snapshot.actorEmail,
    actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
    actorLedgerPartyName: snapshot.ledgerPartyName,
    actorLedgerPartyKind: snapshot.ledgerPartyKind,
    purpose: "file_import",
    trigger: input.trigger ?? "manual",
    status: "running",
    vendorAccountId: input.vendorAccountId,
    vendorId: account.vendorId,
    cause: "member_request",
    attempt: 1,
  });
  return {
    id: row.id,
    publicId: row.shortcode,
    status: row.status,
    dispatchEventId: row.dispatchEventId,
    created: true,
  };
}

/**
 * A member's running Pi Mail import Run with a live dispatch identity: the
 * coordinator lifecycle subject (dispatch, acknowledgement, pause/resume,
 * settlement, expiry) without admitting retained mail.
 */
export async function startAgentRunFixture(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    status?: "running" | "paused_auth" | "dispatch_failed";
  },
) {
  const [party] = await getDb(db)
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(eq(ledgerParty.id, input.ledgerPartyId))
    .limit(1);
  if (!party?.userId)
    throw new Error("Agent Run fixture party has no member owner");
  const snapshot = await actorSnapshot(getDb(db), party.userId);
  const id = runEntityId.parse(crypto.randomUUID());
  const row = await insertWithShortcode(db, "run", {
    id,
    ledgerPartyId: input.ledgerPartyId,
    actorUserId: party.userId,
    actorName: snapshot.actorName,
    actorEmail: snapshot.actorEmail,
    actorLedgerPartyShortcode: snapshot.ledgerPartyShortcode,
    actorLedgerPartyName: snapshot.ledgerPartyName,
    actorLedgerPartyKind: snapshot.ledgerPartyKind,
    purpose: "mail_import",
    trigger: "discovery",
    status: input.status ?? "running",
    channel: "system",
    cause: "source_discovered",
    dispatchEventId: crypto.randomUUID(),
    agentSessionId: importRunAgentIdentity(id, "mail_import"),
  });
  return {
    id: row.id,
    publicId: row.shortcode,
    status: row.status,
    dispatchEventId: row.dispatchEventId,
    agentSessionId: row.agentSessionId,
    created: true,
  };
}

/**
 * A completed member Mail import Run that wrote one Purchase with one
 * Product-linked Expense. By default the write is source-owned (an accepted
 * mail source claim and order association); `auditLogged` instead records the
 * Purchase only in the audit log, the shape predecessor audit recovery reads.
 */
export async function importedPurchaseFixture(
  db: Database,
  actor: ActorContext,
  options: {
    auditLogged?: boolean;
    complete?: boolean;
    party?: typeof ledgerParty.$inferSelect;
    vendor?: typeof vendorTable.$inferSelect;
    orderId?: string;
  } = {},
) {
  const party =
    options.party ??
    (await insertWithShortcode(db, "ledgerParty", {
      name: "Example import owner",
      kind: "member",
      userId: actor.userId,
    }));
  const parent = await insertWithShortcode(db, "run", {
    purpose: "mail_import",
    trigger: "manual",
    status: "completed",
    ledgerPartyId: party.id,
    actorUserId: actor.userId,
    actorName: party.name,
    actorEmail: "import@example.test",
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
  if (options.auditLogged) {
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
    const photo = await createImageFixture(db, "imported-product-cover", {
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
