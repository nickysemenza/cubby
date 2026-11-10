import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  recordShipmentEvidenceInput,
  associateShipmentInput,
  mergeShipmentInput,
  reassignShipmentEvidenceInput,
  editShipmentObservationInput,
  shipmentObservationInput,
  type RecordShipmentEvidenceInput,
} from "@cubby/schemas/shipment-evidence";
import { type ShipmentExtraTrackingNumberRemovals } from "@cubby/schemas/shipment-fields";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
  withTransaction,
} from "~/server/db/helpers";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  shipmentObservationCapture,
  email,
  ledgerParty,
  purchase,
  vendor,
} from "~/server/db/schema";
import {
  carrierCaptureEvidence,
  deliveryFieldCodes,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { constraintViolation, createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { finalizeMerge, mergeNotes } from "~/server/generic/merge/repo/core";

import {
  deduplicateShipmentTrackingReferences,
  shipmentTrackingReferenceKey,
} from "./carrier-references";
import {
  retainedRecordInput,
  type ShipmentWriterInput,
} from "./evidence-input";
import {
  assertPurchaseSourceOwner,
  assertShipmentAssociation,
  canonical,
  canonicalDigest,
  canonicalShipment,
  carrierReference,
  lockShipmentWrites,
  purchaseReference,
  shipmentPurposesDisagree,
} from "./evidence-internal";
import { validateNotificationDates } from "./evidence-packet-plan";
import {
  processShipmentPacket,
  type PacketState,
} from "./evidence-packet-stage";
import { loadSourceCapture, applySourceCapture } from "./evidence-source";

export async function recordShipmentEvidence(
  db: Database,
  raw: RecordShipmentEvidenceInput,
  actor: ActorContext,
) {
  return writeShipmentEvidence(
    db,
    recordShipmentEvidenceInput.parse(raw),
    actor,
  );
}

/** Only retained order extraction ingestion uses this boundary; public records require provenance. */
export async function recordRetainedShipmentEvidence(
  db: Database,
  raw: z.input<typeof retainedRecordInput>,
  actor: ActorContext,
) {
  return writeShipmentEvidence(db, retainedRecordInput.parse(raw), actor);
}

async function writeShipmentEvidence(
  db: Database,
  input: ShipmentWriterInput,
  actor: ActorContext,
) {
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const source = await loadSourceCapture(tdb, input, actor);
    const capture = await applySourceCapture(tdb, source);
    const { sourceKey, ownerId, notificationDate } = source;
    validateNotificationDates({
      sourceKind: input.source.kind,
      notificationDate,
      shipments: input.shipments,
    });
    const purchaseId = await purchaseReference(tdb, input.purchaseId);
    await assertPurchaseSourceOwner(tdb, purchaseId, ownerId);
    const observedAt =
      input.source.kind !== "email"
        ? new Date(input.source.capturedAt)
        : new Date();
    const sourceEvidence = carrierCaptureEvidence(capture);
    const deliveryCodes = deliveryFieldCodes(sourceEvidence);
    const state: PacketState = {
      shipmentIds: [],
      unresolvedPackages: [],
      insertedObservations: 0,
      repeatedObservations: 0,
    };
    for (const submitted of input.shipments)
      await processShipmentPacket(
        tdb,
        {
          input,
          actor,
          capture,
          sourceKey,
          ownerId,
          notificationDate,
          purchaseId,
          observedAt,
          sourceEvidence,
          deliveryCodes,
          submitted,
        },
        state,
      );
    return {
      shipmentIds: [...new Set(state.shipmentIds)],
      insertedObservations: state.insertedObservations,
      repeatedObservations: state.repeatedObservations,
      unresolvedPackages: state.unresolvedPackages,
    };
  });
}

export async function editShipmentObservation(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return constraintViolation(
      "Observation edits require an interactive member decision.",
    );
  const input = editShipmentObservationInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const database = getDb(tdb);
    const [original] = await database
      .select()
      .from(shipmentObservation)
      .where(
        and(
          eq(shipmentObservation.id, input.observationId),
          eq(shipmentObservation.shipmentId, row.id),
        ),
      );
    if (!original)
      return constraintViolation(
        "The observation does not belong to this Shipment.",
      );
    const [capture] = await database
      .select()
      .from(shipmentSourceCapture)
      .where(eq(shipmentSourceCapture.id, original.sourceCaptureId));
    if (!capture)
      return constraintViolation("The retained source capture is missing.");
    if (capture.emailId) {
      const [owner] = await database
        .select({ id: email.id })
        .from(email)
        .innerJoin(ledgerParty, eq(ledgerParty.id, email.ledgerPartyId))
        .where(
          and(
            eq(email.id, capture.emailId),
            notDeleted(email),
            notDeleted(ledgerParty),
            eq(ledgerParty.userId, actor.userId),
          ),
        );
      if (!owner)
        return constraintViolation(
          "The member does not own this observation's Email source.",
        );
    } else if (capture.actorUserId !== actor.userId) {
      return constraintViolation(
        "The member does not own this observation's tracking capture.",
      );
    }
    const event = shipmentObservationInput.parse({
      ...original.event,
      ...input.patch,
    });
    if (
      event.timeBasis === "notification_received" &&
      capture.source.kind === "tracking_page"
    )
      return constraintViolation(
        "Tracking pages do not have a notification receipt date.",
      );
    if (
      event.timeBasis === "notification_received" &&
      event.time.kind !== "date"
    )
      return constraintViolation(
        "Notification fallback uses its calendar date at date-only precision.",
      );
    const carrier = await carrierReference(
      tdb,
      event.carrierId,
      event.carrierName,
    );
    event.carrierId = carrier.code;
    const fingerprint = await canonicalDigest(event);
    const result = { shipmentId: parseShortcodeFor("shipment", row.shortcode) };
    if (original.supersededById) {
      const [successor] = await database
        .select()
        .from(shipmentObservation)
        .where(eq(shipmentObservation.id, original.supersededById));
      if (
        successor &&
        !successor.supersededById &&
        successor.fingerprint === fingerprint &&
        successor.memberReviewed
      )
        return result;
      return constraintViolation(
        "The observation was superseded; read the current revision before editing.",
      );
    }
    if (canonical(original.event) === canonical(event)) return result;
    const now = new Date();
    const [revision] = await database
      .insert(shipmentObservation)
      .values({
        shipmentId: row.id,
        sourceCaptureId: original.sourceCaptureId,
        sourceKey: original.sourceKey,
        sourcePackageId: original.sourcePackageId,
        sourceEventKey: original.sourceEventKey,
        occurrenceKey: original.occurrenceKey,
        fingerprint,
        event,
        memberReviewed: true,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();
    if (!revision) throw new Error("Observation revision was not retained.");
    await database
      .update(shipmentObservation)
      .set({ supersededById: revision.id })
      .where(eq(shipmentObservation.id, original.id));
    const memberships = await database
      .select()
      .from(shipmentObservationCapture)
      .where(eq(shipmentObservationCapture.observationId, original.id));
    if (memberships.length)
      await database.insert(shipmentObservationCapture).values(
        memberships.map((membership) => ({
          observationId: revision.id,
          captureId: membership.captureId,
          firstSeenAt: membership.firstSeenAt,
          lastSeenAt: membership.lastSeenAt,
        })),
      );
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes: {
          observation: { from: original.event, to: event },
          observationRevision: { from: original.id, to: revision.id },
        },
      },
    ]);
    return result;
  });
}

export async function associateShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return constraintViolation(
      "Shipment reassignment requires an interactive member decision.",
    );
  const input = associateShipmentInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const purchaseId = await purchaseReference(tdb, input.purchaseId);
    await assertShipmentAssociation(tdb, row.id, purchaseId);
    await getDb(tdb)
      .update(shipment)
      .set({ purchaseId, purchaseAssociationReviewed: true })
      .where(eq(shipment.id, row.id));
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes: { purchaseId: { from: row.purchaseId, to: purchaseId } },
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", row.shortcode) };
  });
}

export async function mergeShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return constraintViolation(
      "Shipment merging requires an interactive member decision.",
    );
  const input = mergeShipmentInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const source = await canonicalShipment(tdb, input.sourceId);
    const target = await canonicalShipment(tdb, input.targetId);
    if (source.id === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    if (shipmentPurposesDisagree(source.purpose, target.purpose))
      return constraintViolation(
        "Shipment directions disagree; explicitly correct the direction before merging.",
      );
    if (
      source.purchaseId &&
      target.purchaseId &&
      source.purchaseId !== target.purchaseId
    )
      return constraintViolation(
        "Shipments belong to different Purchases; explicitly correct the association before merging.",
      );
    if (
      source.purchaseAssociationReviewed &&
      target.purchaseAssociationReviewed &&
      source.purchaseId !== target.purchaseId
    )
      return constraintViolation(
        "Reviewed Shipment associations disagree; correct them before merging.",
      );
    const purchaseId = target.purchaseAssociationReviewed
      ? target.purchaseId
      : source.purchaseAssociationReviewed
        ? source.purchaseId
        : (target.purchaseId ?? source.purchaseId);
    if (purchaseId) {
      const [order] = await getDb(tdb)
        .select({ id: purchase.id })
        .from(purchase)
        .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
        .for("share");
      if (!order)
        return constraintViolation(
          "The merged Shipment's Purchase is no longer live.",
        );
    }
    await assertShipmentAssociation(tdb, source.id, purchaseId);
    await assertShipmentAssociation(tdb, target.id, purchaseId);
    const refs = [
      ...target.extraTrackingNumbers,
      ...source.extraTrackingNumbers,
    ];
    if (source.trackingNumber) {
      const carrierId = source.carrierId;
      const [carrier] = carrierId
        ? await getDb(tdb)
            .select()
            .from(vendor)
            .where(eq(vendor.id, carrierId))
            .limit(1)
        : [];
      refs.push({
        carrierId: carrier
          ? parseShortcodeFor("vendor", carrier.shortcode)
          : null,
        carrierName: carrier?.name ?? null,
        trackingNumber: source.trackingNumber,
      });
    }
    const mergedCarrierId =
      target.carrierId ??
      (!target.trackingNumber || target.trackingNumber === source.trackingNumber
        ? source.carrierId
        : null);
    await getDb(tdb)
      .update(shipment)
      .set({
        purchaseId,
        notes: mergeNotes(target.notes, source.notes),
        carrierId: mergedCarrierId,
        trackingNumber: target.trackingNumber ?? source.trackingNumber,
        purpose: target.purpose === "unknown" ? source.purpose : target.purpose,
        purchaseAssociationReviewed:
          target.purchaseAssociationReviewed ||
          source.purchaseAssociationReviewed,
        extraTrackingNumbers: await deduplicateShipmentTrackingReferences(tdb, {
          trackingNumber: target.trackingNumber ?? source.trackingNumber,
          carrierId: mergedCarrierId,
          extraTrackingNumbers: refs,
        }),
      })
      .where(eq(shipment.id, target.id));
    if (mergedCarrierId !== target.carrierId)
      await logAuditEntries(tdb, actor, [
        {
          entityKind: "shipment",
          entityId: target.id,
          action: "update",
          changes: {
            carrierId: { from: target.carrierId, to: mergedCarrierId },
          },
        },
      ]);
    await getDb(tdb)
      .update(shipmentObservation)
      .set({ shipmentId: target.id })
      .where(eq(shipmentObservation.shipmentId, source.id));
    await getDb(tdb)
      .update(shipmentSourcePackage)
      .set({ shipmentId: target.id })
      .where(eq(shipmentSourcePackage.shipmentId, source.id));
    await withTransaction(tdb, (tx) =>
      finalizeMerge(tx, {
        entity: "shipment",
        table: shipment,
        keepId: target.id,
        loserIds: [source.id],
        removal: "soft",
        actor,
        survivorChanges: { mergedFrom: { from: null, to: source.shortcode } },
      }),
    );
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}

export async function reassignShipmentEvidence(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return constraintViolation(
      "Shipment evidence reassignment requires an interactive member decision.",
    );
  const input = reassignShipmentEvidenceInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const target = await canonicalShipment(tdb, input.targetShipmentId);
    const [binding] = await getDb(tdb)
      .select()
      .from(shipmentSourcePackage)
      .where(eq(shipmentSourcePackage.id, input.sourcePackageId))
      .limit(1);
    if (!binding)
      return constraintViolation(
        "The source package identity no longer exists.",
      );
    if (binding.shipmentId === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    const [previous] = await getDb(tdb)
      .select({ shortcode: shipment.shortcode })
      .from(shipment)
      .where(eq(shipment.id, binding.shipmentId));
    if (!previous)
      return constraintViolation("The previous Shipment is missing.");
    const sources = await getDb(tdb)
      .select({ ownerId: email.ledgerPartyId })
      .from(shipmentObservation)
      .innerJoin(
        shipmentSourceCapture,
        eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
      )
      .innerJoin(email, eq(email.id, shipmentSourceCapture.emailId))
      .where(eq(shipmentObservation.sourcePackageId, binding.id));
    for (const source of sources)
      await assertPurchaseSourceOwner(tdb, target.purchaseId, source.ownerId);
    await getDb(tdb)
      .update(shipmentSourcePackage)
      .set({ shipmentId: target.id })
      .where(eq(shipmentSourcePackage.id, binding.id));
    await getDb(tdb)
      .update(shipmentObservation)
      .set({ shipmentId: target.id })
      .where(eq(shipmentObservation.sourcePackageId, binding.id));
    const [remaining] = await getDb(tdb)
      .select({ id: shipmentObservation.id })
      .from(shipmentObservation)
      .where(eq(shipmentObservation.shipmentId, binding.shipmentId))
      .limit(1);
    // An emptied source is the same historical package, not another live shell.
    if (!remaining)
      await mergeShipment(
        tdb,
        { sourceId: previous.shortcode, targetId: target.shortcode },
        actor,
      );
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: target.id,
        action: "update",
        changes: {
          reassignedFromShipmentId: {
            from: previous.shortcode,
            to: target.shortcode,
          },
          sourcePackageId: { from: null, to: input.sourcePackageId },
        },
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}

/** Ordinary carrier and extra-reference edits share the Shipment identity writer and audit history. */
export async function editShipmentReferences(
  db: Database,
  input: {
    shipmentId: ShortcodeFor<"shipment">;
    carrierId?: ShortcodeFor<"vendor"> | null;
    extraTrackingNumbers?: ShipmentExtraTrackingNumberRemovals;
  },
  actor: ActorContext,
) {
  if (actor.runId || actor.channel === "system")
    return constraintViolation(
      "Carrier and tracking reference edits require an interactive member request; automated changes use source intake.",
    );
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const carrierId =
      input.carrierId === undefined
        ? row.carrierId
        : (await carrierReference(tdb, input.carrierId, null)).id;
    // Removal is a member decision; only source intake can establish a new reference
    // and its identity checks. A carrier edit alone removes no distinct reference.
    const current = new Set(
      row.extraTrackingNumbers.map(shipmentTrackingReferenceKey),
    );
    const removed = new Set<string>();
    for (const { key } of input.extraTrackingNumbers ?? []) {
      const identity = shipmentTrackingReferenceKey(key);
      if (!current.has(identity))
        throw createAppError(
          "COLLECTION_PATCH_PRECONDITION_FAILED",
          `Shipment extraTrackingNumbers has no "${key.trackingNumber}" under carrier ${key.carrierId ?? "unknown"} to remove; nothing changed.`,
        );
      removed.add(identity);
    }
    // A reference the new primary covers is no longer a separate handoff, and the
    // replaced carrier is not retained as one.
    const extraTrackingNumbers = await deduplicateShipmentTrackingReferences(
      tdb,
      {
        trackingNumber: row.trackingNumber,
        carrierId,
        extraTrackingNumbers: row.extraTrackingNumbers.filter(
          (ref) => !removed.has(shipmentTrackingReferenceKey(ref)),
        ),
      },
    );
    const changes = {
      ...(carrierId === row.carrierId
        ? {}
        : { carrierId: { from: row.carrierId, to: carrierId } }),
      ...(canonical(extraTrackingNumbers) ===
      canonical(row.extraTrackingNumbers)
        ? {}
        : {
            extraTrackingNumbers: {
              from: row.extraTrackingNumbers,
              to: extraTrackingNumbers,
            },
          }),
    };
    const shipmentId = parseShortcodeFor("shipment", row.shortcode);
    if (!Object.keys(changes).length) return { shipmentId };
    await getDb(tdb)
      .update(shipment)
      .set({ carrierId, extraTrackingNumbers })
      .where(eq(shipment.id, row.id));
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes,
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId };
  });
}
