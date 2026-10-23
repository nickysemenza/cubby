import type { ActorContext } from "@cubby/schemas/context";
import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import {
  recordShipmentEvidenceInput,
  associateShipmentInput,
  mergeShipmentInput,
  reassignShipmentEvidenceInput,
  type RecordShipmentEvidenceInput,
  type ShipmentEvidence,
} from "@cubby/schemas/shipment-evidence";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

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
  vendorAccount,
  vendor,
} from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { loadImportScope } from "~/server/domains/purchase-import/repo/import-scope";
import { assertMailRunMembership } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { assertMailSourceIdentityReady } from "~/server/domains/purchase-import/repo/mail-source-identity";
import {
  resolveProductBrand,
  resolveProductBrandName,
} from "~/server/domains/vendor/repo/product-brand";
import { resolveEntityIdentity } from "~/server/entity-kernel/repo/entity-identity";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { recordDerivedRefreshRoots } from "~/server/generic/derived-refresh/repo/capture.boundary";
import { finalizeMerge } from "~/server/generic/merge/repo/core";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

const refuse = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
const canonical = (value: unknown) => canonicalJson(jsonSnapshot.parse(value));
const normalizeNumber = (value: string) =>
  value.replaceAll(/\s/g, "").toUpperCase();

// Intake and explicit corrections share this transaction lock: replay cannot race a package merge.
async function lockShipmentWrites(db: Database) {
  await getDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('shipment-evidence-intake', 0))`,
  );
}

export async function canonicalShipment(
  db: Database,
  code: string,
  followRedirect = false,
) {
  const identity = await resolveEntityIdentity(db, code);
  const id =
    identity.state === "live" && identity.kind === "shipment"
      ? identity.id
      : followRedirect &&
          identity.state === "redirected" &&
          identity.kind === "shipment" &&
          !identity.canonicalDeletedAt
        ? identity.canonicalId
        : null;
  if (!id)
    return refuse(
      "The Shipment is missing, deleted or merged; use its current SHIP reference for writes.",
    );
  const [row] = await getDb(db)
    .select()
    .from(shipment)
    .where(
      and(eq(shipment.id, parseEntityId("shipment", id)), notDeleted(shipment)),
    )
    .for("update")
    .limit(1);
  if (!row) return refuse("The Shipment is no longer available.");
  return row;
}

async function carrierReference(
  db: Database,
  code: ShipmentEvidence["carrierId"],
  name: string | null,
) {
  const identity = code ? await resolveEntityIdentity(db, code) : null;
  const carrierCode =
    identity?.state === "redirected" &&
    identity.kind === "vendor" &&
    !identity.canonicalDeletedAt
      ? parseShortcodeFor("vendor", identity.canonicalShortcode)
      : (code ?? (await resolveProductBrandName(db, name)));
  return {
    code: carrierCode,
    id: carrierCode
      ? await withTransaction(db, (tx) => resolveProductBrand(tx, carrierCode))
      : null,
  };
}

async function purchaseReference(
  db: Database,
  code: RecordShipmentEvidenceInput["purchaseId"],
) {
  if (!code) return null;
  const id = await resolveOrThrow(db, "purchase", code);
  const [row] = await getDb(db)
    .select({ id: purchase.id })
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .for("share")
    .limit(1);
  if (!row)
    return refuse(
      "The Purchase changed during shipment intake; read it again.",
    );
  return row.id;
}

async function sourceCapture(
  db: Database,
  input: RecordShipmentEvidenceInput,
  actor: ActorContext,
) {
  const source = input.source;
  let emailId: string | null = null;
  let ownerId: string | null = null;
  let sourceKey: string;
  let checksum: string;
  let originalContent: RetainedMail["content"] | null = null;
  if (source.kind === "email") {
    emailId = await resolveOrThrow(db, "email", source.emailId);
    const [message] = await getDb(db)
      .select()
      .from(email)
      .where(and(eq(email.id, emailId), notDeleted(email)))
      .for("share");
    if (!message?.orderMailId)
      return refuse("Shipment Email requires a retained original.");
    const parties = await getDb(db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.userId, actor.userId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      );
    const [original] = await readRetainedMail(
      db,
      {
        ledgerPartyIds: parties.map((row) => row.id),
        orderMailIds: [message.orderMailId],
      },
      "share",
    );
    if (!original || original.rawChecksum !== source.checksum)
      return refuse(
        "Shipment Email is foreign, missing or changed; read its original again.",
      );
    await assertMailSourceIdentityReady(getDb(db), original);
    if (actor.runId) {
      const scope = await loadImportScope(db, actor.runId, actor);
      if (
        scope.ledgerPartyId !== original.ledgerPartyId ||
        scope.status !== "running"
      )
        return refuse(
          "The active import Run does not own this Email or is not running.",
        );
      if (scope.purpose === "mail_import")
        await assertMailRunMembership(getDb(db), actor.runId, original.id);
      else if (scope.purpose !== "file_import")
        return refuse("This Run cannot record shipment evidence.");
    }
    ownerId = original.ledgerPartyId;
    originalContent = original.content;
    sourceKey = `email:${emailId}`;
    checksum = source.checksum;
  } else {
    if (actor.runId)
      return refuse(
        "Unattended mail processing cannot submit browser tracking captures.",
      );
    if (new Date(source.capturedAt).getTime() > Date.now() + 300000)
      return refuse("Tracking capture time cannot be in the future.");
    sourceKey = `tracking_page:${actor.userId}:${source.url}:${source.externalKey}`;
    checksum = await sha256Hex(source.content);
  }
  const [capture] = await getDb(db)
    .insert(shipmentSourceCapture)
    .values({
      sourceKey,
      checksum,
      source,
      originalContent,
      emailId,
      actorUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [shipmentSourceCapture.sourceKey, shipmentSourceCapture.checksum],
      set: { sourceKey },
    })
    .returning();
  if (!capture) throw new Error("Shipment source capture was not retained.");
  return { capture, sourceKey, ownerId };
}

async function assertPurchaseSourceOwner(
  db: Database,
  id: PurchaseId | null,
  ownerId: string | null,
) {
  // Ownership is checked on the Purchase's purchasing account, never inferred from who paid.
  if (!id || !ownerId) return;
  const [row] = await getDb(db)
    .select({ ownerId: vendorAccount.ledgerPartyId })
    .from(purchase)
    .leftJoin(vendorAccount, eq(vendorAccount.id, purchase.vendorAccountId))
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .for("share", { of: purchase });
  if (!row) return refuse("The Shipment's Purchase is no longer live.");
  if (row?.ownerId && row.ownerId !== ownerId)
    refuse("The shipment Email and Purchase belong to different members.");
}

async function assertShipmentAssociation(
  db: Database,
  shipmentId: string,
  purchaseId: PurchaseId | null,
) {
  if (!purchaseId) return;
  const sources = await getDb(db)
    .select({ ownerId: email.ledgerPartyId })
    .from(shipmentObservation)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
    )
    .innerJoin(email, eq(email.id, shipmentSourceCapture.emailId))
    .where(
      eq(shipmentObservation.shipmentId, parseEntityId("shipment", shipmentId)),
    );
  for (const ownerId of new Set(sources.map((source) => source.ownerId)))
    await assertPurchaseSourceOwner(db, purchaseId, ownerId);
}

async function automaticPurchaseAssociation(
  db: Database,
  row: typeof shipment.$inferSelect,
  purchaseId: PurchaseId | null,
) {
  if (row.purchaseAssociationReviewed || row.purchaseId || !purchaseId)
    return row.purchaseId;
  await assertShipmentAssociation(db, row.id, purchaseId);
  return purchaseId;
}

export async function recordShipmentEvidence(
  db: Database,
  raw: RecordShipmentEvidenceInput,
  actor: ActorContext,
) {
  const input = recordShipmentEvidenceInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const database = getDb(tdb);
    const { capture, sourceKey, ownerId } = await sourceCapture(
      tdb,
      input,
      actor,
    );
    const purchaseId = await purchaseReference(tdb, input.purchaseId);
    await assertPurchaseSourceOwner(tdb, purchaseId, ownerId);
    const shipmentIds = [];
    let insertedObservations = 0;
    let repeatedObservations = 0;
    const observedAt =
      input.source.kind === "tracking_page"
        ? new Date(input.source.capturedAt)
        : new Date();
    for (const packet of input.shipments) {
      const carrier = await carrierReference(
        tdb,
        packet.carrierId,
        packet.carrierName,
      );
      const number = packet.trackingNumber
        ? normalizeNumber(packet.trackingNumber)
        : null;
      const packageKey =
        packet.sourceShipmentKey ??
        packet.shipmentId ??
        `${packet.carrierId ?? packet.carrierName ?? "unknown"}:${number}`;
      let row = packet.shipmentId
        ? await canonicalShipment(tdb, packet.shipmentId)
        : undefined;
      const [binding] = await database
        .select()
        .from(shipmentSourcePackage)
        .where(
          and(
            eq(shipmentSourcePackage.sourceKey, sourceKey),
            eq(shipmentSourcePackage.packageKey, packageKey),
          ),
        )
        .limit(1);
      if (binding) {
        const [bound] = await database
          .select()
          .from(shipment)
          .where(eq(shipment.id, binding.shipmentId));
        if (!bound) return refuse("The source package reference is missing.");
        const resolved = await canonicalShipment(tdb, bound.shortcode);
        if (row && row.id !== resolved.id)
          return refuse(
            "This source package already belongs to another Shipment; explicitly reassign it.",
          );
        row = resolved;
      }
      // A number is reusable. Cross-source reuse needs an established Purchase and carrier identity.
      if (
        !row &&
        purchaseId &&
        number &&
        carrier.id &&
        !packet.distinctPackageEvidence
      ) {
        const candidates = await database
          .select()
          .from(shipment)
          .where(and(eq(shipment.purchaseId, purchaseId), notDeleted(shipment)))
          .for("update")
          .then((rows) =>
            rows.filter(
              (candidate) =>
                (candidate.carrierId === carrier.id &&
                  candidate.trackingNumber === number) ||
                candidate.extraTrackingNumbers.some(
                  (reference) =>
                    reference.carrierId === carrier.code &&
                    normalizeNumber(reference.trackingNumber) === number,
                ),
            ),
          );
        if (candidates.length > 1)
          return refuse(
            "Multiple packages match this tracking reference; select a Shipment explicitly.",
          );
        row = candidates[0];
      }
      if (
        row &&
        !row.purchaseAssociationReviewed &&
        purchaseId &&
        row.purchaseId &&
        row.purchaseId !== purchaseId
      )
        return refuse(
          "The Shipment belongs to another Purchase; explicitly reassign it.",
        );
      if (row) await assertPurchaseSourceOwner(tdb, row.purchaseId, ownerId);
      const extraTrackingNumbers = [];
      for (const extra of packet.extraTrackingNumbers) {
        const reference = await carrierReference(
          tdb,
          extra.carrierId,
          extra.carrierName,
        );
        extraTrackingNumbers.push({
          carrierId: reference.code,
          carrierName: extra.carrierName,
          trackingNumber: normalizeNumber(extra.trackingNumber),
        });
      }
      if (!row) {
        row = await insertWithShortcode(tdb, "shipment", {
          name:
            [packet.carrierName, number].filter(Boolean).join(" · ") ||
            "Package",
          purchaseId,
          carrierId: carrier.id,
          trackingNumber: number,
          extraTrackingNumbers,
          purpose: packet.purpose,
        });
        await logAuditEntries(tdb, actor, [
          {
            entityKind: "shipment",
            entityId: row.id,
            action: "create",
            changes: { name: { from: null, to: row.name } },
          },
        ]);
      } else {
        const acceptedPurchaseId = await automaticPurchaseAssociation(
          tdb,
          row,
          purchaseId,
        );
        const refs = [...row.extraTrackingNumbers, ...extraTrackingNumbers];
        if (
          number &&
          (row.trackingNumber !== number || row.carrierId !== carrier.id)
        )
          refs.push({
            carrierId: carrier.code,
            carrierName: packet.carrierName,
            trackingNumber: number,
          });
        const uniqueRefs = [
          ...new Map(refs.map((ref) => [canonical(ref), ref])).values(),
        ];
        await database
          .update(shipment)
          .set({
            purchaseId: acceptedPurchaseId,
            extraTrackingNumbers: uniqueRefs,
          })
          .where(eq(shipment.id, row.id));
      }
      const sourcePackage =
        binding ??
        (
          await database
            .insert(shipmentSourcePackage)
            .values({ shipmentId: row.id, sourceKey, packageKey })
            .returning()
        )[0];
      if (!sourcePackage)
        throw new Error("Source package identity was not retained.");
      shipmentIds.push(parseShortcodeFor("shipment", row.shortcode));
      const occurrences = new Map<string, number>();
      for (const observation of packet.observations) {
        const eventCarrier = await carrierReference(
          tdb,
          observation.carrierId,
          observation.carrierName,
        );
        const event = { ...observation, carrierId: eventCarrier.code };
        const fingerprint = await sha256Hex(canonical(observation));
        const ordinal = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, ordinal + 1);
        const occurrenceKey = event.sourceEventKey
          ? `event:${event.sourceEventKey}`
          : `content:${fingerprint}:${ordinal}`;
        const sameOccurrence = and(
          eq(shipmentObservation.sourcePackageId, sourcePackage.id),
          eq(shipmentObservation.occurrenceKey, occurrenceKey),
        );
        const [current] = await database
          .select()
          .from(shipmentObservation)
          .where(
            and(sameOccurrence, isNull(shipmentObservation.supersededById)),
          )
          .orderBy(desc(shipmentObservation.lastSeenAt))
          .limit(1);
        const versions = await database
          .select()
          .from(shipmentObservation)
          .where(
            and(
              sameOccurrence,
              eq(shipmentObservation.fingerprint, fingerprint),
            ),
          )
          .orderBy(desc(shipmentObservation.firstSeenAt));
        const prior =
          versions.find((version) => version.firstSeenAt <= observedAt) ??
          versions.at(-1);
        // A later A → B → A report is a new version, not a replay of the superseded A.
        const restored =
          prior?.supersededById &&
          current &&
          observedAt >= current.lastSeenAt &&
          observedAt > prior.lastSeenAt;
        let retainedId: string;
        if (prior && !restored) {
          await database
            .update(shipmentObservation)
            .set({
              firstSeenAt: new Date(
                Math.min(prior.firstSeenAt.getTime(), observedAt.getTime()),
              ),
              lastSeenAt: new Date(
                Math.max(prior.lastSeenAt.getTime(), observedAt.getTime()),
              ),
            })
            .where(eq(shipmentObservation.id, prior.id));
          repeatedObservations++;
          retainedId = prior.id;
        } else {
          const [created] = await database
            .insert(shipmentObservation)
            .values({
              shipmentId: row.id,
              sourceCaptureId: capture.id,
              sourceKey,
              sourcePackageId: sourcePackage.id,
              sourceEventKey: event.sourceEventKey,
              occurrenceKey,
              fingerprint,
              event,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
              supersededById:
                current && current.lastSeenAt > observedAt ? current.id : null,
            })
            .returning();
          if (!created)
            throw new Error("Shipment observation was not retained.");
          if (!current || current.lastSeenAt < observedAt)
            await database
              .update(shipmentObservation)
              .set({ supersededById: created.id })
              .where(
                and(
                  sameOccurrence,
                  isNull(shipmentObservation.supersededById),
                  sql`${shipmentObservation.id} <> ${created.id}`,
                ),
              );
          insertedObservations++;
          retainedId = created.id;
        }
        await database
          .insert(shipmentObservationCapture)
          .values({
            observationId: retainedId,
            captureId: capture.id,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          })
          .onConflictDoUpdate({
            target: [
              shipmentObservationCapture.observationId,
              shipmentObservationCapture.captureId,
            ],
            set: {
              firstSeenAt: sql`least(${shipmentObservationCapture.firstSeenAt}, ${observedAt})`,
              lastSeenAt: sql`greatest(${shipmentObservationCapture.lastSeenAt}, ${observedAt})`,
            },
          });
      }
      await recordDerivedRefreshRoots(tdb, [
        { entityKind: "shipment", entityId: row.id },
      ]);
    }
    return {
      shipmentIds: [...new Set(shipmentIds)],
      insertedObservations,
      repeatedObservations,
    };
  });
}

export async function associateShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse(
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
    await recordDerivedRefreshRoots(tdb, [
      { entityKind: "shipment", entityId: row.id },
    ]);
    return { shipmentId: parseShortcodeFor("shipment", row.shortcode) };
  });
}

export async function mergeShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse("Shipment merging requires an interactive member decision.");
  const input = mergeShipmentInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const source = await canonicalShipment(tdb, input.sourceId);
    const target = await canonicalShipment(tdb, input.targetId);
    if (source.id === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    if (
      source.purchaseId &&
      target.purchaseId &&
      source.purchaseId !== target.purchaseId
    )
      return refuse(
        "Shipments belong to different Purchases; explicitly correct the association before merging.",
      );
    if (
      source.purchaseAssociationReviewed &&
      target.purchaseAssociationReviewed &&
      source.purchaseId !== target.purchaseId
    )
      return refuse(
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
        return refuse("The merged Shipment's Purchase is no longer live.");
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
    await getDb(tdb)
      .update(shipment)
      .set({
        purchaseId,
        purchaseAssociationReviewed:
          target.purchaseAssociationReviewed ||
          source.purchaseAssociationReviewed,
        extraTrackingNumbers: [
          ...new Map(refs.map((ref) => [canonical(ref), ref])).values(),
        ],
      })
      .where(eq(shipment.id, target.id));
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
    await recordDerivedRefreshRoots(tdb, [
      { entityKind: "shipment", entityId: source.id },
      { entityKind: "shipment", entityId: target.id },
    ]);
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}

export async function reassignShipmentEvidence(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse(
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
      return refuse("The source package identity no longer exists.");
    if (binding.shipmentId === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    const [previous] = await getDb(tdb)
      .select({ shortcode: shipment.shortcode })
      .from(shipment)
      .where(eq(shipment.id, binding.shipmentId));
    if (!previous) return refuse("The previous Shipment is missing.");
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
    await recordDerivedRefreshRoots(tdb, [
      { entityKind: "shipment", entityId: target.id },
      { entityKind: "shipment", entityId: binding.shipmentId },
    ]);
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}
