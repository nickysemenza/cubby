import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type PurchaseId,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  shipmentObservation,
  shipmentObservationCapture,
  type shipment,
  type shipmentSourceCapture,
  type shipmentSourcePackage,
} from "~/server/db/schema";
import {
  withoutDeliveryFieldCarrier,
  type carrierCaptureEvidence,
  type deliveryFieldCodes,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { recordChange } from "~/server/generic/changes/repo/change";

import { resolveShipmentAdmission } from "./evidence-admission-stage";
import type { ShipmentWriterInput } from "./evidence-input";
import { carrierReference } from "./evidence-internal";
import {
  planObservationWrite,
  type planPacketObservationIdentities,
} from "./evidence-observation-plan";
import { prepareShipmentPacket } from "./evidence-packet-prepare";
import { applyShipmentWrite } from "./evidence-shipment-application";

export type PacketState = {
  shipmentIds: ShortcodeFor<"shipment">[];
  unresolvedPackages: { sourceShipmentKey: string | null; reason: string }[];
  insertedObservations: number;
  repeatedObservations: number;
};
export type PacketContext = {
  input: ShipmentWriterInput;
  actor: ActorContext;
  capture: typeof shipmentSourceCapture.$inferSelect;
  sourceKey: string;
  ownerId: string | null;
  notificationDate: string | null;
  purchaseId: PurchaseId | null;
  observedAt: Date;
  sourceEvidence: ReturnType<typeof carrierCaptureEvidence>;
  deliveryCodes: ReturnType<typeof deliveryFieldCodes>;
  submitted: ShipmentWriterInput["shipments"][number];
};
export async function processShipmentPacket(
  tdb: Database,
  context: PacketContext,
  state: PacketState,
) {
  const { actor } = context;
  const { shipmentIds } = state;
  const prepared = await prepareShipmentPacket(tdb, context, state);
  if (!prepared) return;
  const shipmentPlan = await resolveShipmentAdmission(
    tdb,
    context,
    prepared,
    state,
  );
  if (!shipmentPlan) return;
  const { row, sourcePackage } = await applyShipmentWrite(
    tdb,
    actor,
    shipmentPlan,
  );
  shipmentIds.push(parseShortcodeFor("shipment", row.shortcode));
  await writePacketObservations(
    tdb,
    context,
    { identified: prepared.identified, row, sourcePackage },
    state,
  );
  await recordChange(tdb, { kind: "source", categories: ["shipment"] });
}

async function writePacketObservations(
  tdb: Database,
  context: Pick<
    PacketContext,
    "capture" | "sourceKey" | "observedAt" | "deliveryCodes"
  >,
  input: {
    identified: Awaited<ReturnType<typeof planPacketObservationIdentities>>;
    row: typeof shipment.$inferSelect;
    sourcePackage: typeof shipmentSourcePackage.$inferSelect;
  },
  state: PacketState,
) {
  const { capture, sourceKey, observedAt, deliveryCodes } = context;
  const { identified, row, sourcePackage } = input;
  const database = getDb(tdb);
  for (const {
    observation,
    fingerprint,
    literalFingerprint,
    occurrenceKey,
    revisesFromSameCapture,
  } of identified) {
    const eventHint = await withoutDeliveryFieldCarrier(
      tdb,
      {
        carrierId: observation.carrierId,
        carrierName: observation.carrierName,
      },
      deliveryCodes,
    );
    const eventCarrier = await carrierReference(
      tdb,
      eventHint.carrierId,
      eventHint.carrierName,
    );
    const event = {
      ...observation,
      ...eventHint,
      carrierId: eventCarrier.code,
    };
    const versions = await database
      .select()
      .from(shipmentObservation)
      .where(
        and(
          eq(shipmentObservation.sourcePackageId, sourcePackage.id),
          eq(shipmentObservation.occurrenceKey, occurrenceKey),
        ),
      )
      .orderBy(desc(shipmentObservation.firstSeenAt));
    const current = versions
      .filter((version) => version.supersededById === null)
      .reduce<(typeof versions)[number] | undefined>(
        (latest, version) =>
          !latest || version.lastSeenAt > latest.lastSeenAt ? version : latest,
        undefined,
      );
    const plan = planObservationWrite({
      versions,
      current,
      fingerprint,
      literalFingerprint,
      observedAt,
      revisesFromSameCapture,
      event,
      shipmentId: row.id,
      sourceCaptureId: capture.id,
      sourcePackageId: sourcePackage.id,
      sourceKey,
      occurrenceKey,
    });
    let retainedId: string;
    if (plan.kind === "repeat") {
      await database
        .update(shipmentObservation)
        .set({ firstSeenAt: plan.firstSeenAt, lastSeenAt: plan.lastSeenAt })
        .where(eq(shipmentObservation.id, plan.id));
      retainedId = plan.id;
    } else {
      const [created] = await database
        .insert(shipmentObservation)
        .values(plan.values)
        .returning();
      if (!created) throw new Error("Shipment observation was not retained.");
      if (plan.canSupersede)
        await database
          .update(shipmentObservation)
          .set({ supersededById: created.id })
          .where(
            and(
              eq(
                shipmentObservation.sourcePackageId,
                plan.values.sourcePackageId,
              ),
              eq(shipmentObservation.occurrenceKey, plan.values.occurrenceKey),
              isNull(shipmentObservation.supersededById),
              ne(shipmentObservation.id, created.id),
            ),
          );
      retainedId = created.id;
    }
    await database
      .insert(shipmentObservationCapture)
      .values({
        observationId: retainedId,
        captureId: plan.captureId,
        firstSeenAt: plan.observedAt,
        lastSeenAt: plan.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          shipmentObservationCapture.observationId,
          shipmentObservationCapture.captureId,
        ],
        set: {
          firstSeenAt: sql`least(${shipmentObservationCapture.firstSeenAt}, ${plan.observedAt})`,
          lastSeenAt: sql`greatest(${shipmentObservationCapture.lastSeenAt}, ${plan.observedAt})`,
        },
      });
    if (plan.kind === "repeat") state.repeatedObservations++;
    else state.insertedObservations++;
  }
}
