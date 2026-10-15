/** The import Run scope a member owns and the retained Email an order names; both gate every import write. */
import type { ActorContext } from "@cubby/schemas/context";
import {
  type LedgerPartyId,
  type RunId,
  type VendorId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import {
  importSourceIdentity,
  runPurpose,
  type RunPurpose,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  importPreparedOrder,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/schema";
import {
  retainedMailJoin,
  retainedMailProjection,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";

import { assertMailRunMembership } from "./mail-run-membership";
import { assertMailSourceIdentityReady } from "./mail-source-identity";

export type ImportScope = {
  runId: RunId;
  shortcode: string;
  purpose: RunPurpose;
  status: string;
  ledgerPartyId: LedgerPartyId;
  vendorId: VendorId | null;
  vendorAccountId: string | null;
};

export async function loadImportScope(
  db: Database,
  runId: RunId,
  actor: ActorContext,
): Promise<ImportScope> {
  const [row] = await getDb(db)
    .select({
      runId: runTable.id,
      shortcode: runTable.shortcode,
      purpose: runTable.purpose,
      status: runTable.status,
      ledgerPartyId: runTable.ledgerPartyId,
      actorUserId: runTable.actorUserId,
      vendorId: runTable.vendorId,
      vendorAccountId: runTable.vendorAccountId,
    })
    .from(runTable)
    .where(and(eq(runTable.id, runId), notDeleted(runTable)))
    .limit(1);
  if (!row?.ledgerPartyId)
    throw new Error("Import run ownership is unavailable");
  if (row.actorUserId !== actor.userId)
    throw new Error("Purchase import run is not owned by this member");
  return {
    runId: row.runId,
    shortcode: row.shortcode,
    purpose: runPurpose.parse(row.purpose),
    status: row.status,
    ledgerPartyId: row.ledgerPartyId,
    vendorId: row.vendorId,
    vendorAccountId: row.vendorAccountId,
  };
}

export type RetainedMailSource = RetainedMail;

/** Reuse import ownership and current-original gates for an explicit review. */
export async function assertReviewedPreparationOriginal(
  db: Database,
  order: typeof importPreparedOrder.$inferSelect,
  actor: ActorContext,
  expectedLedgerPartyId: ImportScope["ledgerPartyId"],
) {
  if (order.sourceKind !== "mail_message")
    throw new Error(
      "A current original review requires retained order Email evidence.",
    );
  const scope = await loadImportScope(
    db,
    runEntityId.parse(order.runId),
    actor,
  );
  if (scope.ledgerPartyId !== expectedLedgerPartyId)
    throw new Error(
      "Reviewed preparation must belong to the original source owner.",
    );
  const original = await retainedMailSource(
    db,
    scope,
    {
      kind: "mail_message",
      externalKey: order.sourceExternalKey,
      checksum: order.sourceChecksum,
    },
    order.evidenceChecksum,
  );
  if (
    !original?.content.bodyText?.trim() &&
    !original?.content.bodyHtml?.trim()
  )
    throw new Error(
      "A current original review requires the retained full message body.",
    );
  await assertMailSourceIdentityReady(getDb(db), original);
  return original;
}

/**
 * A mail-sourced order must name the member's own retained Email unchanged,
 * never a model-provided key or bytes. A Mail import Run may use only mail
 * sources of the Emails it admitted: any other kind would carry an arbitrary
 * key and checksum past that check.
 */
export async function retainedMailSource(
  db: Database,
  scope: ImportScope,
  source: z.infer<typeof importSourceIdentity>,
  evidenceChecksum: string,
): Promise<RetainedMailSource | null> {
  if (source.kind !== "mail_message" && source.kind !== "mail_attachment") {
    if (scope.purpose === "mail_import")
      throw new Error("A Mail import Run imports only the Emails it admitted.");
    return null;
  }
  const match = /^gmail:(.+?):([^:]+)(?::attachment:(.+))?$/u.exec(
    source.externalKey,
  );
  const [, mailboxId, messageId, attachmentId] = match ?? [];
  const isAttachment = source.kind === "mail_attachment";
  if (!mailboxId || !messageId || Boolean(attachmentId) !== isAttachment)
    throw new Error(
      "A mail source key is gmail:<mailboxId>:<messageId>[:attachment:<attachmentId>].",
    );
  const database = getDb(db);
  const [retained] = await database
    .select({ mail: retainedMailProjection, message: emailTable })
    .from(orderMail)
    .innerJoin(emailTable, retainedMailJoin)
    .where(
      and(
        eq(orderMail.ledgerPartyId, scope.ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
        eq(emailTable.mailboxId, mailboxId),
        eq(emailTable.messageId, messageId),
      ),
    )
    .limit(1);
  const usable =
    retained &&
    retained.message.orderMailId === retained.mail.id &&
    !["excluded", "deleted"].includes(retained.message.status) &&
    retained.message.classification !== "unrelated";
  let checksum = retained?.mail.rawChecksum;
  if (usable && attachmentId) {
    const [attachment] = await database
      .select({ checksum: orderMailAttachment.checksum })
      .from(orderMailAttachment)
      .where(
        and(
          eq(orderMailAttachment.orderMailId, retained.mail.id),
          eq(orderMailAttachment.providerAttachmentId, attachmentId),
        ),
      )
      .limit(1);
    checksum = attachment?.checksum;
  }
  if (
    !usable ||
    checksum !== source.checksum ||
    evidenceChecksum !== source.checksum
  )
    throw new Error(
      "Purchase import must use the member's retained Email unchanged.",
    );
  if (scope.purpose === "mail_import")
    await assertMailRunMembership(database, scope.runId, retained.mail.id);
  return retained.mail;
}
