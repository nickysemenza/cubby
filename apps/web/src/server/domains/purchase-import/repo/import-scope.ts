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
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  importPreparedOrder,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  run as runTable,
} from "~/server/db/retained-tables";
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

export function parseMailSourceKey(externalKey: string) {
  const [, mailboxId, messageId, attachmentId] =
    /^gmail:(.+?):([^:]+)(?::attachment:(.+))?$/u.exec(externalKey) ?? [];
  return { mailboxId, messageId, attachmentId };
}

const attachmentKeyPrefix = (mailboxId: string, messageId: string) =>
  `gmail:${mailboxId}:${messageId}:attachment:`;

/**
 * The stored provider ids an attachment key's segment may name. A read's
 * `attachmentId` is itself the attachment's source key
 * (`gmail:<mailboxId>:<messageId>:attachment:<part>`) while legacy rows hold
 * the bare part, so a key built from either nests the prefix zero or more
 * times; every depth names the same attachment.
 */
export function mailAttachmentIdCandidates(
  mailboxId: string,
  messageId: string,
  attachmentId: string,
): [bare: string, keyed: string] {
  const prefix = attachmentKeyPrefix(mailboxId, messageId);
  let part = attachmentId;
  while (part.startsWith(prefix)) part = part.slice(prefix.length);
  return [part, `${prefix}${part}`];
}

/**
 * An attachment source key in its stored form,
 * `gmail:<mailboxId>:<messageId>:attachment:<providerAttachmentId>` (the form
 * Email source identity matches in `email-sql.ts`), however deeply the caller
 * nested the attachment's own key. Other keys, and keys naming no retained
 * attachment, return unchanged for the source checks to refuse.
 */
export async function canonicalMailSourceKey(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  source: z.infer<typeof importSourceIdentity>,
): Promise<string> {
  if (source.kind !== "mail_attachment") return source.externalKey;
  const { mailboxId, messageId, attachmentId } = parseMailSourceKey(
    source.externalKey,
  );
  if (!mailboxId || !messageId || !attachmentId) return source.externalKey;
  const rows = await getDb(db)
    .select({ id: orderMailAttachment.providerAttachmentId })
    .from(orderMailAttachment)
    .innerJoin(orderMail, eq(orderMail.id, orderMailAttachment.orderMailId))
    .innerJoin(emailTable, retainedMailJoin)
    .where(
      and(
        eq(orderMail.ledgerPartyId, ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
        eq(emailTable.mailboxId, mailboxId),
        eq(emailTable.messageId, messageId),
        inArray(
          orderMailAttachment.providerAttachmentId,
          mailAttachmentIdCandidates(mailboxId, messageId, attachmentId),
        ),
      ),
    );
  const stored = rows.find((row) => row.id === attachmentId)?.id ?? rows[0]?.id;
  return stored
    ? `${attachmentKeyPrefix(mailboxId, messageId)}${stored}`
    : source.externalKey;
}

/**
 * A mail-sourced order must name the member's own retained Email unchanged,
 * never a model-provided key or bytes. Validate before source judgments;
 * the writer additionally requires roster membership through retainedMailSource.
 * A Mail import Run cannot use another kind to bypass original validation.
 */
export async function readUnchangedMailSource(
  db: Database,
  scope: { ledgerPartyId: LedgerPartyId; purpose: RunPurpose | null },
  source: z.infer<typeof importSourceIdentity>,
  evidenceChecksum: string,
): Promise<RetainedMailSource | null> {
  if (source.kind !== "mail_message" && source.kind !== "mail_attachment") {
    if (scope.purpose === "mail_import")
      throw new Error("A Mail import Run imports only the Emails it admitted.");
    return null;
  }
  const { mailboxId, messageId, attachmentId } = parseMailSourceKey(
    source.externalKey,
  );
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
  return retained.mail;
}

/** Writer authority adds roster membership to the original's deterministic checks. */
export async function retainedMailSource(
  db: Database,
  scope: ImportScope,
  source: z.infer<typeof importSourceIdentity>,
  evidenceChecksum: string,
): Promise<RetainedMailSource | null> {
  const retained = await readUnchangedMailSource(
    db,
    scope,
    source,
    evidenceChecksum,
  );
  if (retained && scope.purpose === "mail_import")
    await assertMailRunMembership(getDb(db), scope.runId, retained.id);
  return retained;
}
