import type { Database } from "~/server/db";
import type { shipment, shipmentSourcePackage } from "~/server/db/schema";
import { withoutDeliveryFieldCarrier } from "~/server/domains/shipment/repo/carrier-evidence";

import { carrierReference } from "./evidence-internal";
import { applyObservationWrite } from "./evidence-observation-application";
import { loadObservationRevision } from "./evidence-observation-load";
import {
  planObservationWrite,
  type planPacketObservationIdentities,
} from "./evidence-observation-plan";
import type { PacketContext, PacketState } from "./evidence-packet-stage";
export async function writePacketObservations(
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
    const { current, versions } = await loadObservationRevision(
      tdb,
      sourcePackage.id,
      occurrenceKey,
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
    await applyObservationWrite(tdb, plan);
    if (plan.kind === "repeat") state.repeatedObservations++;
    else state.insertedObservations++;
  }
}
