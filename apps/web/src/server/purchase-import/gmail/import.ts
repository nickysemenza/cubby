import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import {
  orderMailImportInput,
  orderMailImportOut,
  type OrderMailImportInput,
} from "@cubby/schemas/order-mail-review";
import { orderMailImportRunInput } from "@cubby/schemas/run-fields";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  importSourceClaim,
  ledgerParty,
  orderMail,
  orderMailEvent,
  run as runTable,
  user,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { dispatchRunEvent } from "../dispatch";

export async function startOrderMailImport(
  db: Database,
  rawInput: OrderMailImportInput,
  actor: ActorContext,
  queue: PurchaseAgentQueueProducer,
) {
  const input = orderMailImportInput.parse(rawInput);
  const admitted = await withTransaction(db, async (tx) => {
    // Lock the saved message so concurrent clicks reuse one source/run. Shipping
    // events never confer authority to import a placement's itemization.
    const [row] = await tx
      .select({
        mail: orderMail,
        event: orderMailEvent,
        actorName: user.name,
        actorEmail: user.email,
        partyShortcode: ledgerParty.shortcode,
        partyName: ledgerParty.name,
        partyKind: ledgerParty.kind,
      })
      .from(orderMailEvent)
      .innerJoin(orderMail, eq(orderMail.id, orderMailEvent.orderMailId))
      .innerJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, orderMail.ledgerPartyId),
          eq(ledgerParty.userId, actor.userId),
          notDeleted(ledgerParty),
        ),
      )
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(eq(orderMailEvent.id, input.eventId))
      .limit(1)
      .for("update", { of: orderMail });
    if (!row) throw new Error("Order email was not found for this member.");
    if (
      row.event.event !== "placed" ||
      row.event.supersededAt ||
      !row.event.orderId
    )
      throw new Error(
        "Import requires an active order confirmation with an explicit order id.",
      );
    if (row.mail.rawChecksum !== input.evidenceChecksum)
      throw new Error(
        "Order email evidence changed; refresh before importing.",
      );
    if (!row.mail.vendorId)
      throw new Error("Classify the email vendor before importing.");
    if (!row.mail.content.bodyText && !row.mail.content.bodyHtml)
      throw new Error("Order confirmation has no saved body to extract.");
    const [existing] = await tx
      .select()
      .from(runTable)
      .where(
        and(
          eq(runTable.ledgerPartyId, row.mail.ledgerPartyId),
          eq(runTable.vendorId, row.mail.vendorId),
          sql`${runTable.input}->>'kind' = 'order_mail_import'`,
          sql`${runTable.input}->>'eventId' = ${input.eventId}`,
          sql`${runTable.input}->>'evidenceChecksum' = ${input.evidenceChecksum}`,
        ),
      )
      .orderBy(desc(runTable.startedAt))
      .limit(1);
    if (existing)
      return {
        run: existing,
        dispatch:
          existing.status === "dispatch_failed" ||
          (existing.status === "running" && existing.dispatchAttempts === 0),
      };
    const id = runEntityId.parse(crypto.randomUUID());
    const run = await insertWithShortcode(tx, "run", {
      id,
      ledgerPartyId: row.mail.ledgerPartyId,
      vendorId: row.mail.vendorId,
      vendorAccountId: null,
      purpose: "account_sync",
      trigger: "manual",
      actorUserId: actor.userId,
      actorName: row.actorName,
      actorEmail: row.actorEmail,
      actorLedgerPartyShortcode: row.partyShortcode,
      actorLedgerPartyName: row.partyName,
      actorLedgerPartyKind: row.partyKind,
      coordinatorModel: "gpt-6-sol",
      agentSessionId: importRunAgentIdentity(id, "account_sync"),
      dispatchEventId: crypto.randomUUID(),
      clientKey: `order-mail:${input.eventId}:${input.evidenceChecksum}`,
      input: orderMailImportRunInput.parse({
        kind: "order_mail_import",
        ...input,
        orderId: row.event.orderId,
      }),
    });
    return { run, dispatch: true };
  });
  if (admitted.dispatch) {
    if (!admitted.run.dispatchEventId)
      throw new Error("Order email import has no dispatch generation.");
    await dispatchRunEvent(db, queue, {
      version: 1,
      runId: admitted.run.id,
      eventId: admitted.run.dispatchEventId,
      type: "start_or_resume",
    });
  }
  return orderMailImportOut.parse({ runId: admitted.run.shortcode });
}

export async function loadOrderMailImportEvidence(db: Database, runId: string) {
  const [run] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (
    !run ||
    !run.input ||
    !("kind" in run.input) ||
    run.input.kind !== "order_mail_import"
  )
    return null;
  const input = orderMailImportRunInput.parse(run.input);
  if (!run.ledgerPartyId || !run.vendorId || !run.actorUserId)
    throw new Error("Order email import ownership is unavailable.");
  const [row] = await getDb(db)
    .select({ mail: orderMail, event: orderMailEvent })
    .from(orderMailEvent)
    .innerJoin(
      orderMail,
      and(
        eq(orderMail.id, orderMailEvent.orderMailId),
        eq(orderMail.ledgerPartyId, run.ledgerPartyId),
        eq(orderMail.vendorId, run.vendorId),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, orderMail.ledgerPartyId),
        eq(ledgerParty.userId, run.actorUserId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(orderMailEvent.id, input.eventId),
        isNull(orderMailEvent.supersededAt),
      ),
    )
    .limit(1)
    .for("share", { of: orderMail });
  if (
    !row ||
    row.mail.rawChecksum !== input.evidenceChecksum ||
    row.event.event !== "placed" ||
    row.event.orderId !== input.orderId
  )
    throw new Error(
      "Assigned order confirmation evidence changed or is no longer available to this member.",
    );
  return {
    eventId: input.eventId,
    orderId: input.orderId,
    evidenceChecksum: input.evidenceChecksum,
    source: {
      kind: "mail_message" as const,
      externalKey: `gmail:${row.mail.messageId}:order:${input.orderId}`,
      checksum: input.evidenceChecksum,
    },
    mail: row.mail,
  };
}

export async function orderMailImportIsCommitted(
  db: Database,
  evidence: NonNullable<
    Awaited<ReturnType<typeof loadOrderMailImportEvidence>>
  >,
) {
  const [claim] = await getDb(db)
    .select({ purchaseId: importSourceClaim.purchaseId })
    .from(importSourceClaim)
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, evidence.mail.ledgerPartyId),
        eq(importSourceClaim.kind, evidence.source.kind),
        eq(importSourceClaim.externalKey, evidence.source.externalKey),
        eq(importSourceClaim.checksum, evidence.source.checksum),
      ),
    )
    .limit(1);
  return Boolean(claim?.purchaseId);
}
