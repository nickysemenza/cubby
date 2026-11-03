import { assessmentSubjects } from "@cubby/schemas/assessment";
import { entitySchema } from "@cubby/schemas/entity";
import {
  retainedShipmentEvidence,
  type RetainedShipmentEvidence,
} from "@cubby/schemas/shipment-evidence";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db/database";
import { assessment, shipmentSourceCapture } from "~/server/db/retained-tables";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

/** A read projection over the shared immutable evidence ledger; no Shipment packet table. */
export const shipmentCarrierEvidence = new QueryBuilder()
  .select({
    id: assessment.id,
    captureId: sql<string>`(${assessment.origin}->>'id')::uuid`.as(
      "carrierPacketCaptureId",
    ),
    // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- metadata is the existing immutable Assessment origin JSON key.
    packageKey: sql<string>`${assessment.origin}->'metadata'->>'packageKey'`.as(
      "carrierPacketKey",
    ),
    fingerprint: assessment.fingerprint,
    packet: sql<RetainedShipmentEvidence>`${assessment.evidence}->'packet'`.as(
      "carrierPacketPayload",
    ),
  })
  .from(assessment)
  .where(
    and(
      eq(assessment.family, "field"),
      sql`${assessment.subject}->>'entity' = ${entitySchema.enum.shipment}`,
      sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = 'carrierId'`,
      // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- kind is an immutable evidence JSON key.
      sql`${assessment.evidence}->>'kind' = 'shipment_carrier_packet'`,
      // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- table is the existing immutable Assessment origin JSON key.
      sql`${assessment.origin}->>'table' = 'ShipmentSourceCapture'`,
    ),
  )
  .as("shipment_carrier_evidence");

export async function retainCarrierPacket(
  db: Database,
  capture: typeof shipmentSourceCapture.$inferSelect,
  packageKey: string,
  packet: RetainedShipmentEvidence,
) {
  const retained = retainedShipmentEvidence.parse(packet);
  const fingerprint = await sha256Hex(
    canonicalJson(jsonSnapshot.parse(retained)),
  );
  return publishAssessment(db, {
    publicationKey: `shipment-carrier-packet:v1:${capture.id}:${packageKey}:${fingerprint}`,
    family: "field",
    subject: {
      kind: "field",
      entity: "shipment",
      recordId: null,
      field: "carrierId",
      draft: true,
    },
    judgment: { value: null },
    fingerprint,
    producer: {
      kind: "rule",
      model: null,
      revision: "shipment-carrier-evidence@1",
      // A retained source packet is shared across import Runs; replay cannot change its producer.
      runId: null,
      evaluationId: null,
    },
    evidence: jsonSnapshot.parse({
      kind: "shipment_carrier_packet",
      packet: retained,
    }),
    origin: {
      table: "ShipmentSourceCapture",
      id: capture.id,
      metadata: { packageKey },
    },
    served: false,
  });
}
