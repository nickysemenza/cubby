import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  importExtractionOutcome,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { moneyToMinor } from "@cubby/shared";
import { and, inArray, isNull, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  email,
  ledgerParty,
  orderMail,
  sourceOrderObservation,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import {
  orderEventKey,
  orderPaymentKeys,
  paymentAmountKey,
} from "~/server/domains/purchase-import/policy/payment-keys";
import {
  append,
  defineEvidence,
  evidenceRow,
  rowKey,
} from "~/server/kernel/api";
import { jsonSnapshot, sha256CanonicalJson } from "~/server/lib/canonical-json";
export {
  orderEventKey,
  orderPaymentKeys,
  paymentAmountKey,
  paymentOrderKey,
} from "~/server/domains/purchase-import/policy/payment-keys";

/** Email and its originals resolve viewer ownership in one roster query. */
export async function resolveMailOwners(db: Database, ids: readonly string[]) {
  const rows = await repositoryQueries(db)
    .select({ id: ledgerParty.id, userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(
      and(
        inArray(
          ledgerParty.id,
          ids.map((id) => parseEntityId("ledgerParty", id)),
        ),
        isNull(ledgerParty.deletedAt),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.userId]));
}

export const emailEvidence = defineEvidence({
  kind: "email",
  table: email,
  entity: "email",
  keys: (row) => [
    rowKey("Email", row.id),
    `mail:${row.ledgerPartyId}:${row.provider}:${row.mailboxId}:${row.messageId}`,
  ],
  discovers: (row) => [{ kind: "emailState", key: row.id }],
  owner: (row) => row.ledgerPartyId,
  resolveOwners: resolveMailOwners,
});

export async function appendEmailIdentity(
  db: Database,
  options: {
    where: SQL | undefined;
    values(): Omit<typeof email.$inferInsert, "shortcode">;
  },
) {
  if (!options.where)
    throw new Error("Email identity requires an exact source predicate");
  const q = repositoryQueries(db);
  const [existing] = await q.select().from(email).where(options.where).limit(1);
  if (existing) return { row: existing, created: false };
  const id = parseEntityId("email", crypto.randomUUID());
  const facts = await append(db, [
    evidenceRow(emailEvidence, { ...options.values(), id }),
  ]);
  const [row] = await q.select().from(email).where(options.where).limit(1);
  if (!row) throw new Error("Appended Email identity is missing");
  return { row, created: facts.some((fact) => fact.id === id) };
}

export const mailOriginalEvidence = defineEvidence({
  kind: "mailOriginal",
  table: orderMail,
  keys: (row) => [
    rowKey("OrderMail", row.id),
    `mail:checksum:${row.rawChecksum}`,
  ],
  discovers: () => [],
  owner: (row) => row.ledgerPartyId,
  resolveOwners: resolveMailOwners,
});

/** The accepted extraction is the order fact; the raw original is only its source. */
export const orderEvidence = defineEvidence({
  kind: "orderObservation",
  table: sourceOrderObservation,
  keys: (row) => [
    rowKey("SourceOrderObservation", row.id),
    `order:${row.orderKey}`,
    orderEventKey(row),
    ...(row.emailId ? [rowKey("Email", row.emailId)] : []),
    ...orderPaymentKeys(row),
  ],
  discovers: (row) => [
    { kind: "purchaseEvent", key: orderEventKey(row) },
    ...orderPaymentKeys(row).map((key) => ({ kind: "paymentMatch", key })),
    ...(row.emailId ? [{ kind: "emailState", key: row.emailId }] : []),
  ],
  owner: (row) => row.ledgerPartyId,
  resolveOwners: resolveMailOwners,
});

export const retainedPaymentEvidence = defineEvidence({
  kind: "retainedPayment",
  table: purchasePaymentEvidence,
  keys: (row) => [
    rowKey("PurchasePaymentEvidence", row.id),
    paymentAmountKey(row.amountMinor),
  ],
  discovers: (row) => [
    { kind: "paymentMatch", key: paymentAmountKey(row.amountMinor) },
  ],
});

/** Appends accepted Email, export, browser and receipt-photo facts before booking. */
export async function appendOrderEvidence(
  db: Database,
  inputs: readonly {
    input: ImportWriterInput;
    orderKey: string;
    emailId?: string | null;
    answerHash?: string | null;
  }[],
) {
  const rows = await Promise.all(
    inputs.map(async ({ input, orderKey, emailId, answerHash }) => {
      const extraction = importExtractionOutcome.parse(input.extraction);
      const productBindings = (extraction.candidate?.lines ?? []).map(
        (_, lineIndex) => {
          const resolution = input.productResolutions?.find(
            (row) => row.lineIndex === lineIndex,
          );
          return {
            lineIndex,
            productId:
              resolution?.kind === "existing" ? resolution.productId : null,
          };
        },
      );
      const contentFingerprint = await sha256CanonicalJson(
        jsonSnapshot.parse({
          extraction,
          productBindings,
          primaryDocumentImageId: input.primaryDocumentImageId,
          screenshotImageId: input.screenshotImageId,
        }),
      );
      return evidenceRow(orderEvidence, {
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        vendorId: parseEntityId("vendor", input.vendorId),
        orderKey,
        sourceKind: input.source.kind,
        sourceExternalKey: input.source.externalKey,
        emailId: emailId ? parseEntityId("email", emailId) : null,
        answerHash: answerHash ?? null,
        runId: input.runId,
        checksum: input.source.checksum,
        extraction,
        productBindings,
        primaryDocumentImageId: input.primaryDocumentImageId,
        screenshotImageId: input.screenshotImageId,
        contentFingerprint,
      });
    }),
  );
  await append(db, rows);
  if (!inputs.length) return [];
  const observations = await repositoryQueries(db)
    .select()
    .from(sourceOrderObservation)
    .where(
      inArray(
        sourceOrderObservation.orderKey,
        inputs.map((row) => row.orderKey),
      ),
    )
    .orderBy(sourceOrderObservation.createdAt, sourceOrderObservation.id);
  await append(
    db,
    observations.flatMap((observation) =>
      observation.sourceClaimId !== null ||
      observation.extraction.candidate?.currency !== "USD"
        ? []
        : (observation.extraction.candidate?.payments ?? []).map(
            (payment, evidenceIndex) =>
              evidenceRow(retainedPaymentEvidence, {
                orderObservationId: observation.id,
                amountMinor: moneyToMinor(payment.amount),
                chargedAt: payment.chargedAt
                  ? new Date(payment.chargedAt)
                  : null,
                cardLastFour: payment.cardLastFour ?? null,
                tender: payment.tender ?? "unknown",
                evidenceIndex,
              }),
          ),
    ),
  );
  return observations;
}
