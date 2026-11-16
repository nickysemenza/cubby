import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  importExtractionOutcome,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { moneyToMinor } from "@cubby/shared";
import { and, eq, or, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { requestedRows } from "~/server/db/helpers/requested";
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
  sameOrderOriginal,
} from "~/server/domains/purchase-import/policy/payment-keys";
import { sourceObservationIdentitySql } from "~/server/domains/purchase-import/repo/reconciliation-observations";
import {
  append,
  defineEvidence,
  evidenceRow,
  rowKey,
} from "~/server/kernel/api";
import {
  canonicalJson,
  jsonSnapshot,
  sha256CanonicalJson,
} from "~/server/lib/canonical-json";
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
  const values = options.values();
  const id = values.id ?? parseEntityId("email", crypto.randomUUID());
  const {
    classification,
    classificationStage,
    classificationReason,
    classificationVersion,
    ...identity
  } = values;
  const facts = await append(db, [
    evidenceRow(emailEvidence, { ...identity, id }),
  ]);
  const [row] = await q.select().from(email).where(options.where).limit(1);
  if (!row) throw new Error("Appended Email identity is missing");
  if (facts.some((fact) => fact.id === id) && classification !== undefined) {
    const { updateEmailStateWhere } =
      await import("~/server/domains/email/repo/email-state-mutations");
    const { eq } = await import("drizzle-orm");
    const [projected] = await updateEmailStateWhere(
      db,
      {
        classification,
        classificationStage,
        classificationReason,
        classificationVersion,
      },
      eq(email.id, id),
    );
    return { row: projected ?? row, created: true };
  }
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
    ...orderPaymentKeys(row).map((key) => ({ kind: "purchaseEvent", key })),
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
    { kind: "purchaseEvent", key: paymentAmountKey(row.amountMinor) },
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
    retainedSubject?: {
      sourceClaimId: string;
      purchaseId: import("@cubby/schemas/identifiers").PurchaseId;
    };
  }[],
) {
  const rows = await Promise.all(
    inputs.map(
      async ({ input, orderKey, emailId, answerHash, retainedSubject }) => {
        const extraction = importExtractionOutcome.parse(input.extraction);
        // Preparation handles belong to one request. Source line identities must
        // survive a replay with different handles and preserve duplicate lines.
        const lineHashes = await Promise.all(
          (extraction.candidate?.lines ?? []).map((line) =>
            sha256CanonicalJson(jsonSnapshot.parse(line)),
          ),
        );
        const occurrences = new Map<string, number>();
        const productBindings = (extraction.candidate?.lines ?? []).map(
          (_, lineIndex) => {
            const resolution = input.productResolutions?.find(
              (row) => row.lineIndex === lineIndex,
            );
            const hash = lineHashes[lineIndex]!;
            const occurrence = occurrences.get(hash) ?? 0;
            occurrences.set(hash, occurrence + 1);
            return {
              lineIndex,
              stableLineId: `${hash}:${occurrence}`,
              createProduct: resolution?.kind === "new",
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
          ...retainedSubject,
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
          createdAt: new Date(),
        });
      },
    ),
  );
  if (!inputs.length) return [];
  const readCandidates = () =>
    repositoryQueries(db)
      .select()
      .from(sourceOrderObservation)
      .where(
        inArray(
          sourceOrderObservation.orderKey,
          inputs.map((row) => row.orderKey),
        ),
      )
      .orderBy(sourceOrderObservation.createdAt, sourceOrderObservation.id);
  const unboundInputs = new Set(
    rows
      .filter(
        (_, index) => inputs[index]!.input.productResolutions === undefined,
      )
      .map((row) => row.values),
  );
  const matches = (
    row: typeof sourceOrderObservation.$inferSelect,
    values: (typeof rows)[number]["values"],
  ) =>
    row.ledgerPartyId === values.ledgerPartyId &&
    row.vendorId === values.vendorId &&
    row.orderKey === values.orderKey &&
    row.sourceKind === values.sourceKind &&
    (row.sourceExternalKey === values.sourceExternalKey ||
      (values.sourceClaimId != null &&
        row.sourceClaimId === values.sourceClaimId)) &&
    row.checksum === values.checksum &&
    (row.contentFingerprint === values.contentFingerprint ||
      (unboundInputs.has(values) &&
        canonicalJson(jsonSnapshot.parse(row.extraction)) ===
          canonicalJson(jsonSnapshot.parse(values.extraction)) &&
        row.primaryDocumentImageId === values.primaryDocumentImageId &&
        row.screenshotImageId === values.screenshotImageId));
  const previous = await readCandidates();
  // Retained claim ownership is not another source observation. Reuse the
  // exact immutable fact before append, including after a Vendor merge.
  await append(
    db,
    rows.filter(({ values }) => !previous.some((row) => matches(row, values))),
  );
  const candidates = await readCandidates();
  // A later repair of the same source and order is distinct accepted evidence;
  // callers must receive exactly the immutable facts they just supplied.
  const observations = rows.map(({ values }) => {
    const observation = candidates.find((row) => matches(row, values));
    if (!observation) throw new Error("Accepted extraction is missing");
    return observation;
  });
  const identities = requestedRows(
    observations.map((row) => ({
      ledgerPartyId: row.ledgerPartyId,
      vendorId: row.vendorId,
      sourceKind: row.sourceKind,
      sourceExternalKey: row.sourceExternalKey,
      orderKey: row.orderKey,
      checksum: row.checksum,
    })),
    {
      ledgerPartyId: "uuid",
      vendorId: "uuid",
      sourceKind: "text",
      sourceExternalKey: "text",
      orderKey: "text",
      checksum: "text",
    },
    "wanted",
  );
  const originalPayments = observations.length
    ? await repositoryQueries(db)
        .select({
          payment: purchasePaymentEvidence,
          original: sourceOrderObservation,
        })
        .from(sourceOrderObservation)
        .innerJoin(
          purchasePaymentEvidence,
          or(
            eq(
              purchasePaymentEvidence.orderObservationId,
              sourceOrderObservation.id,
            ),
            and(
              isNull(purchasePaymentEvidence.orderObservationId),
              eq(
                purchasePaymentEvidence.sourceClaimId,
                sourceOrderObservation.sourceClaimId,
              ),
              sourceObservationIdentitySql(
                "purchase",
                sourceOrderObservation.purchaseId,
                purchasePaymentEvidence.purchaseId,
              ),
            ),
          ),
        ).where(sql`EXISTS (SELECT 1 FROM ${identities.from}
          WHERE ${sourceOrderObservation.ledgerPartyId} = ${identities.col("ledgerPartyId")}
            AND ${sourceOrderObservation.vendorId} = ${identities.col("vendorId")}
            AND ${sourceOrderObservation.sourceKind} = ${identities.col("sourceKind")}
            AND ${sourceOrderObservation.sourceExternalKey} = ${identities.col("sourceExternalKey")}
            AND ${sourceOrderObservation.orderKey} = ${identities.col("orderKey")}
            AND ${sourceOrderObservation.checksum} = ${identities.col("checksum")})`)
    : [];
  const plannedPayments: {
    original: (typeof observations)[number];
    evidenceIndex: number;
  }[] = [];
  await append(
    db,
    observations.flatMap((observation) =>
      observation.extraction.candidate?.currency !== "USD"
        ? []
        : (observation.extraction.candidate?.payments ?? []).flatMap(
            (payment, evidenceIndex) => {
              if (
                plannedPayments.some(
                  (held) =>
                    held.evidenceIndex === evidenceIndex &&
                    sameOrderOriginal(held.original, observation),
                ) ||
                originalPayments.some(
                  (held) =>
                    sameOrderOriginal(held.original, observation) &&
                    held.payment.evidenceIndex === evidenceIndex &&
                    held.payment.amountMinor === moneyToMinor(payment.amount) &&
                    (held.payment.chargedAt?.getTime() ?? null) ===
                      (payment.chargedAt
                        ? new Date(payment.chargedAt).getTime()
                        : null) &&
                    held.payment.cardLastFour ===
                      (payment.cardLastFour ?? null) &&
                    held.payment.tender === (payment.tender ?? "unknown"),
                )
              )
                return [];
              plannedPayments.push({ original: observation, evidenceIndex });
              return [
                evidenceRow(retainedPaymentEvidence, {
                  orderObservationId: observation.id,
                  amountMinor: moneyToMinor(payment.amount),
                  chargedAt: payment.chargedAt
                    ? new Date(payment.chargedAt)
                    : null,
                  cardLastFour: payment.cardLastFour ?? null,
                  tender: payment.tender ?? "unknown",
                  description: payment.description ?? null,
                  evidenceIndex,
                }),
              ];
            },
          ),
    ),
  );
  return observations;
}
