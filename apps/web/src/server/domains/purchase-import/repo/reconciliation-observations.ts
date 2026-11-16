import { entityIdSchema, parseEntityId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party-fields";
import {
  acceptedSourceOrder,
  importExtractionOutcome,
  importSourceKind,
  sourceOrderObservationBindings,
  type ImportWriterInput,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { databaseForTransaction } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers";
import { requestedRows } from "~/server/db/helpers/requested";
import { evidenceBinding, recordKey } from "~/server/db/kernel-schema";
import {
  entityIdentity,
  entityAttachment,
  importSourceProduct,
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  user,
  vendor,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import { orderEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import { acceptedOrders } from "~/server/domains/purchase-import/repo/accepted-order-read";
import {
  type LiveSourceOrder,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "~/server/domains/purchase-import/repo/source-claim-family";
import { append, evidenceRow } from "~/server/kernel/api";
import { enterWriteTransaction } from "~/server/kernel/gate";
import { jsonSnapshot } from "~/server/lib/canonical-json";

/** JSONB changes object-key order; review hashes must describe values, not serialization order. */
export function reconciliationFingerprint(value: unknown): Promise<string> {
  const objectSchema = z.record(z.string(), z.json());
  const canonical = (input: z.infer<typeof jsonSnapshot>): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    const object = objectSchema.safeParse(input);
    if (!object.success) return JSON.stringify(input);
    return `{${Object.keys(object.data)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object.data[key]!)}`)
      .join(",")}}`;
  };
  return sha256Hex(canonical(jsonSnapshot.parse(value)));
}

/** Subject-free captures prove their Purchase through the live economic event owner. */
export async function sourceObservationOwnsPurchase(
  tx: Pick<DrizzleTransaction, "select">,
  observation: typeof sourceOrderObservation.$inferSelect,
  purchaseId: typeof purchase.$inferSelect.id,
): Promise<boolean> {
  if (observation.purchaseId)
    return sourceObservationIdentityMatches(
      tx,
      "purchase",
      observation.purchaseId,
      purchaseId,
    );
  const bindings = await tx
    .select({ key: evidenceBinding.eventKey })
    .from(evidenceBinding)
    .where(
      and(
        eq(evidenceBinding.factKind, "orderObservation"),
        eq(evidenceBinding.factId, observation.id),
      ),
    );
  const [owner] = await tx
    .select({ id: recordKey.entityId })
    .from(recordKey)
    .where(
      and(
        eq(recordKey.scopeKind, "purchaseEvent"),
        eq(recordKey.entity, "purchase"),
        eq(recordKey.entityId, purchaseId),
        isNull(recordKey.mergedAt),
        isNull(recordKey.rejectedAt),
        inArray(recordKey.scopeKey, [
          ...new Set([
            orderEventKey(observation),
            ...bindings.map((row) => row.key),
          ]),
        ]),
      ),
    );
  return !!owner;
}

export async function recordSourceOrderObservation(
  tx: DrizzleTransaction,
  identity: Pick<
    typeof sourceOrderObservation.$inferInsert,
    "sourceClaimId" | "orderKey" | "purchaseId"
  >,
  input: Pick<
    ImportWriterInput,
    | "vendorId"
    | "source"
    | "extraction"
    | "primaryDocumentImageId"
    | "screenshotImageId"
    | "productResolutions"
  > & { runId: typeof sourceOrderObservation.$inferSelect.runId },
  bindings = sourceOrderObservationBindings.parse(
    (input.extraction.candidate?.lines ?? []).map((_, lineIndex) => {
      const resolution = input.productResolutions?.find(
        (row) => row.lineIndex === lineIndex,
      );
      return {
        lineIndex,
        productId:
          resolution?.kind === "existing" ? resolution.productId : null,
      };
    }),
  ),
) {
  if (!identity.sourceClaimId || !identity.purchaseId)
    throw new Error(
      "A retained source association requires its original subject",
    );
  const extraction = importExtractionOutcome.parse(input.extraction);
  const productBindings = sourceOrderObservationBindings.parse(bindings);
  const contentFingerprint = await reconciliationFingerprint({
    checksum: input.source.checksum,
    extraction,
    productBindings,
    primaryDocumentImageId: input.primaryDocumentImageId,
    screenshotImageId: input.screenshotImageId,
  });
  const [source] = await tx
    .select({ ledgerPartyId: importSourceClaim.ledgerPartyId })
    .from(importSourceClaim)
    .where(eq(importSourceClaim.id, identity.sourceClaimId));
  const values = {
    ...identity,
    ledgerPartyId: source?.ledgerPartyId ?? null,
    sourceKind: input.source.kind,
    sourceExternalKey: input.source.externalKey,
    vendorId: parseEntityId("vendor", input.vendorId),
    runId: input.runId,
    checksum: input.source.checksum,
    extraction,
    productBindings,
    primaryDocumentImageId: input.primaryDocumentImageId,
    screenshotImageId: input.screenshotImageId,
    contentFingerprint,
  };
  // The same content is observed once per subject. A merged Purchase reuses
  // its original observation; a deleted Purchase keeps its observation as
  // history while the order's next import observes the content anew. Content
  // already naming another live Purchase is an ownership change.
  const observed = await tx
    .select({
      observation: sourceOrderObservation,
      subjectDeletedAt: purchase.deletedAt,
      samePurchase: sourceObservationIdentitySql(
        "purchase",
        sourceOrderObservation.purchaseId,
        sql`${identity.purchaseId}`,
      ),
      sameVendor: sourceObservationIdentitySql(
        "vendor",
        sourceOrderObservation.vendorId,
        sql`${values.vendorId}`,
      ),
    })
    .from(sourceOrderObservation)
    .innerJoin(purchase, eq(purchase.id, sourceOrderObservation.purchaseId))
    .where(
      and(
        eq(sourceOrderObservation.sourceClaimId, identity.sourceClaimId),
        eq(sourceOrderObservation.orderKey, identity.orderKey),
        eq(sourceOrderObservation.checksum, input.source.checksum),
        eq(sourceOrderObservation.contentFingerprint, contentFingerprint),
      ),
    )
    .orderBy(asc(sourceOrderObservation.createdAt));
  for (const { observation, samePurchase, sameVendor } of observed)
    if (samePurchase) {
      if (sameVendor) return observation;
      throw new Error(
        "Source observation identity changed; review its ownership.",
      );
    }
  if (observed.some((row) => row.subjectDeletedAt === null))
    throw new Error(
      "Source observation identity changed; review its ownership.",
    );
  const observationId = crypto.randomUUID();
  await append(databaseForTransaction(tx), [
    evidenceRow(
      (await import("~/server/domains/purchase-import/repo/order-evidence"))
        .orderEvidence,
      { ...values, id: observationId, createdAt: new Date() },
    ),
  ]);
  const [created] = await tx
    .select()
    .from(sourceOrderObservation)
    .where(eq(sourceOrderObservation.id, observationId));
  if (!created)
    throw new Error(
      "Source observation identity changed; review its ownership.",
    );
  return created;
}

const observationIdentity = alias(
  entityIdentity,
  "source_observation_identity",
);

/** Existing Entity redirects are compressed at merge; historical UUIDs never move. */
export function sourceObservationIdentitySql(
  kind: "purchase" | "vendor" | "product",
  original: SQLWrapper,
  current: SQLWrapper,
) {
  return sql<boolean>`(${original} = ${current} OR EXISTS (
    SELECT 1 FROM ${entityIdentity} AS "source_observation_identity"
    WHERE ${observationIdentity.id} = ${original}
      AND ${observationIdentity.kind} = ${kind}
      AND ${observationIdentity.mergedIntoId} = ${current}
  ))`;
}

export async function sourceObservationIdentityMatches(
  tx: Pick<DrizzleTransaction, "select">,
  kind: "purchase" | "vendor" | "product",
  original: string,
  current: string,
) {
  if (original === current) return true;
  const [identity] = await tx
    .select({ id: entityIdentity.id })
    .from(entityIdentity)
    .where(
      and(
        eq(entityIdentity.id, original),
        eq(entityIdentity.kind, kind),
        eq(entityIdentity.mergedIntoId, current),
      ),
    );
  return Boolean(identity);
}

/** Promote stored evidence only; absent historical decisions and media remain unknown. */
export async function promoteHistoricalAcceptedObservation(
  tx: DrizzleTransaction,
  sourceOrderId: string,
) {
  await enterWriteTransaction(tx, { lane: "money", mode: "member" });
  const [initial] = await tx
    .select()
    .from(importSourceOrder)
    .where(eq(importSourceOrder.id, sourceOrderId));
  // A deleted Purchase's detached history has no live subject to observe.
  if (!initial || initial.acceptedObservationId || initial.purchaseId === null)
    return initial?.acceptedObservationId ?? null;
  const preliminary = acceptedSourceOrder.safeParse(initial.originalOrder);
  if (!preliminary.success || preliminary.data.checksum !== initial.checksum)
    return null;
  const [owned] = await tx
    .select({ claim: importSourceClaim })
    .from(importSourceClaim)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.kind, ledgerPartyKind.enum.member),
        notDeleted(ledgerParty),
      ),
    )
    .innerJoin(user, eq(user.id, ledgerParty.userId))
    .where(eq(importSourceClaim.id, initial.sourceClaimId));
  if (!owned) return null;
  const claim = owned.claim;
  const family = await readImportSourceClaimFamily(
    tx,
    {
      ledgerPartyId: claim.ledgerPartyId,
      kind: claim.kind,
      externalKey: claim.externalKey,
    },
    { lock: "update" },
  );
  if (!family) return null;
  const retained = await readSourceFamilyOrder(
    tx,
    family,
    initial.orderKey,
    "update",
  );
  if (retained?.association.id !== initial.id)
    throw new Error("Historical accepted source family identity changed.");
  const order = retained.association;
  if (order.acceptedObservationId) return order.acceptedObservationId;
  const parsed = acceptedSourceOrder.safeParse(order.originalOrder);
  if (!parsed.success || parsed.data.checksum !== order.checksum) return null;
  const [ownedTarget] = await tx
    .select({ target: purchase })
    .from(purchase)
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(and(eq(purchase.id, order.purchaseId), notDeleted(purchase)))
    .for("update", { of: purchase });
  if (!ownedTarget) return null;
  const target = ownedTarget.target;
  const historicalVendor = entityIdSchema("vendor").safeParse(
    order.orderKey.split("/")[0],
  );
  if (
    !historicalVendor.success ||
    !(await sourceObservationIdentityMatches(
      tx,
      "vendor",
      historicalVendor.data,
      target.vendorId,
    ))
  )
    return null;
  const observation = await recordSourceOrderObservation(
    tx,
    {
      sourceClaimId: order.sourceClaimId,
      orderKey: order.orderKey,
      purchaseId: order.purchaseId,
    },
    {
      vendorId: historicalVendor.data,
      runId: null,
      source: {
        kind: importSourceKind.parse(claim.kind),
        externalKey: claim.externalKey,
        checksum: order.checksum,
      },
      extraction: parsed.data.extraction,
      primaryDocumentImageId: null,
      screenshotImageId: null,
    },
  );
  await tx
    .update(importSourceOrder)
    .set({ acceptedObservationId: observation.id })
    .where(eq(importSourceOrder.id, order.id));
  return observation.id;
}

/** A historical accepted extraction whose bytes were overwritten remains unknown. */
export async function acceptedSourceExtraction(
  tx: Pick<DrizzleTransaction, "select">,
  order: LiveSourceOrder,
) {
  if (order.acceptedObservationId) {
    const [observation] = await tx
      .select()
      .from(acceptedOrders)
      .where(eq(acceptedOrders.id, order.acceptedObservationId));
    let ownedClaim = observation?.sourceClaimId === order.sourceClaimId;
    if (observation && observation.sourceClaimId === null) {
      const [claim] = await tx
        .select()
        .from(importSourceClaim)
        .where(eq(importSourceClaim.id, order.sourceClaimId));
      const family = claim
        ? await readImportSourceClaimFamily(tx, claim)
        : null;
      const retained = family
        ? await readSourceFamilyOrder(tx, family, order.orderKey)
        : null;
      ownedClaim =
        !!family &&
        retained?.association.id === order.id &&
        observation.ledgerPartyId === family.root.ledgerPartyId &&
        family.members.some(
          (member) =>
            member.kind === observation.sourceKind &&
            member.externalKey === observation.sourceExternalKey,
        );
    }
    if (
      !observation ||
      !observation.purchaseId ||
      !ownedClaim ||
      observation.orderKey !== order.orderKey ||
      !(await sourceObservationIdentityMatches(
        tx,
        "purchase",
        observation.purchaseId,
        order.purchaseId,
      )) ||
      observation.checksum !== order.checksum
    )
      throw new Error(
        "Accepted source observation no longer matches its association.",
      );
    const [target] = await tx
      .select({ vendorId: purchase.vendorId })
      .from(purchase)
      .where(and(eq(purchase.id, order.purchaseId), notDeleted(purchase)));
    if (
      !target ||
      !(await sourceObservationIdentityMatches(
        tx,
        "vendor",
        observation.vendorId,
        target.vendorId,
      ))
    )
      throw new Error(
        "Accepted source observation vendor no longer matches its association.",
      );
    return acceptedSourceOrder.parse(observation);
  }
  return order.originalOrder?.checksum === order.checksum
    ? acceptedSourceOrder.parse(order.originalOrder)
    : null;
}

/** Publish retained source correspondences and provenance after the kernel proves the reviewed money. */
export async function recordReviewedSourceMetadata(
  tx: DrizzleTransaction,
  state: import("./reconciliation-state").ReconciliationState,
  fix: import("./reconciliation-state").ReconciliationFix,
  plan: import("./reconciliation-plan").ReconciliationPlan,
  head: typeof sourceOrderObservation.$inferSelect,
  lineExpenses: ReadonlyMap<number, string>,
  actor: import("@cubby/schemas/context").ActorContext,
  current: import("zod").z.infer<
    typeof import("@cubby/schemas/purchase-import").sourceOrderReconciliationReview
  >,
): Promise<void> {
  const {
    planReconciliationBindings,
    planReconciliationOutputFingerprint,
    planReconciliationFinal,
  } = await import("./reconciliation-plan");
  const claimId =
    state.association?.sourceClaimId ??
    state.observation.sourceClaimId ??
    state.family.root.id;
  const [first] = await tx
    .select()
    .from(acceptedOrders)
    .where(
      and(
        or(
          inArray(
            acceptedOrders.sourceClaimId,
            state.family.members.map((row) => row.id),
          ),
          and(
            isNull(acceptedOrders.sourceClaimId),
            eq(acceptedOrders.ledgerPartyId, state.family.root.ledgerPartyId),
            sql`EXISTS (SELECT 1 FROM ${
              requestedRows(
                state.family.members.map((row) => ({
                  kind: row.kind,
                  externalKey: row.externalKey,
                })),
                { kind: "text", externalKey: "text" },
                "family_source",
              ).from
            }
          WHERE family_source.kind=${acceptedOrders.sourceKind} AND family_source."externalKey"=${acceptedOrders.sourceExternalKey})`,
          ),
        ),
        eq(acceptedOrders.orderKey, fix.orderKey),
        eq(acceptedOrders.purchaseId, state.target.id),
      ),
    )
    .orderBy(asc(acceptedOrders.createdAt), asc(acceptedOrders.id))
    .limit(1);
  if (!first)
    throw new Error("Reviewed source observation provenance is missing");
  const outputFingerprint = await planReconciliationOutputFingerprint(
    state,
    fix,
  );
  const originalOrder = state.association?.originalOrder ?? {
    checksum: first.checksum,
    extraction: first.extraction,
  };
  const [association] = await tx
    .insert(importSourceOrder)
    .values({
      sourceClaimId: claimId,
      orderKey: fix.orderKey,
      purchaseId: state.target.id,
      checksum: head.checksum,
      outputFingerprint,
      originalOrder,
      acceptedObservationId: head.id,
    })
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      targetWhere: isNotNull(importSourceOrder.purchaseId),
      set: {
        purchaseId: state.target.id,
        checksum: head.checksum,
        outputFingerprint,
        acceptedObservationId: head.id,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!association)
    throw new Error("Reviewed source association was not persisted");
  const bindings = await planReconciliationBindings(
    state,
    plan,
    first,
    association.id,
    new Map(
      [...lineExpenses].map(([index, id]) => [
        index,
        parseEntityId("expense", id),
      ]),
    ),
  );
  if (bindings.detached.length)
    await tx
      .update(importSourceProduct)
      .set({ expenseId: null })
      .where(inArray(importSourceProduct.id, bindings.detached));
  if (bindings.bindings.length)
    await tx
      .insert(importSourceProduct)
      .values(
        bindings.bindings.map((row) => ({
          sourceOrderId: association.id,
          ...row,
        })),
      )
      .onConflictDoUpdate({
        target: [
          importSourceProduct.sourceOrderId,
          importSourceProduct.lineIndex,
        ],
        set: { expenseId: sql`excluded."expenseId"` },
      });
  if (plan.header.imageIds.length)
    await tx
      .insert(entityAttachment)
      .values(
        plan.header.imageIds.map((imageId) => ({
          entityId: state.target.id,
          entityKind: "purchase" as const,
          role: "attachment" as const,
          imageId,
          documentKind: "order_confirmation" as const,
        })),
      )
      .onConflictDoNothing();
  const final = planReconciliationFinal(
    state,
    current,
    plan,
    head,
    fix,
    state.family.root.ledgerPartyId,
  );
  if (final.shipment)
    await (
      await import("~/server/domains/purchase-import/repo/shipment-intake")
    ).recordImportedShipmentEvidence(
      databaseForTransaction(tx),
      final.shipment,
      actor,
    );
  await (
    await import("~/server/generic/audit-log/repo/audit-log")
  ).logAuditEntry(tx, actor, final.audit);
}
