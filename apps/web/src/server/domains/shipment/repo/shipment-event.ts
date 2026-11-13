import {
  shipmentPurpose,
  shipmentExtraTrackingNumbers,
} from "@cubby/schemas/shipment-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { shipment, shipmentPackageObservation } from "~/server/db/schema";
import {
  defineEvidence,
  defineReconciler,
  rowKey,
  recordSubject,
  source,
  writes,
} from "~/server/kernel/api";

export const shipmentPackageEvidence = defineEvidence({
  kind: "shipment.package",
  table: shipmentPackageObservation,
  keys: (row) => [
    `shipment:${row.scopeKey}`,
    rowKey("ShipmentPackageObservation", row.id),
  ],
  discovers: (row) => [{ kind: "shipment", key: row.scopeKey }],
  owner: (row) => row.actorUserId,
});
export const shipmentColumns = [
  "name",
  "purchaseId",
  "carrierId",
  "trackingNumber",
  "extraTrackingNumbers",
  "purpose",
  "orderId",
  "purchaseAssociationReviewed",
  "notes",
] as const;
export const shipmentRecords = writes(shipment, shipmentColumns, {
  entity: "shipment",
});
const header = z.object({
  name: z.string(),
  purchaseId: z.string().nullable().optional(),
  carrierId: z.string().nullable().optional(),
  trackingNumber: z.string().nullable().optional(),
  extraTrackingNumbers: shipmentExtraTrackingNumbers.optional(),
  purpose: shipmentPurpose.optional(),
  orderId: z.string().nullable().optional(),
  purchaseAssociationReviewed: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});
type Input = {
  key: string;
  observations: (typeof shipmentPackageObservation.$inferSelect)[];
  rows: (typeof shipment.$inferSelect)[];
};

/** Accepted, normalized package headers and member decisions fill a single Shipment identity. */
export const shipmentEvent = defineReconciler<Input>({
  scope: "shipment",
  lane: "money",
  version: 1,
  after: ["purchaseEvent"],
  reads: [
    source.evidence(shipmentPackageEvidence),
    source.table(shipment, shipmentColumns),
  ],
  writes: [shipmentRecords],
  async load(reads, keys) {
    const [observations, rows] = await Promise.all([
      reads.facts(
        shipmentPackageEvidence,
        keys.map((key) => `shipment:${key}`),
      ),
      reads.select(shipment, [], sql`true`),
    ]);
    return new Map(
      keys.map((key) => [
        key,
        { key, observations: observations.get(`shipment:${key}`) ?? [], rows },
      ]),
    );
  },
  reconcile(input, c) {
    const key = c.existing(shipmentRecords)[0] ?? "shipment";
    const id = c.identity(shipmentRecords, key).id;
    if (
      c.decision("rejection", recordSubject("shipment", id))?.kind === "reject"
    ) {
      for (const key of c.existing(shipmentRecords))
        c.retire(shipmentRecords, key, "keep");
      return c.done();
    }
    const stored = input.rows.find((row) => row.id === id && !row.deletedAt);
    const observations = [...input.observations].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const values = {
      ...(stored
        ? Object.fromEntries(
            shipmentColumns.map((field) => [field, stored[field]]),
          )
        : {}),
      ...Object.assign(
        {},
        ...observations.map((row) => header.partial().parse(row.values)),
      ),
    };
    const choices = c.assignments(recordSubject("shipment", id));
    const provenance: Record<string, string> = {};
    for (const [field, choice] of choices)
      if (shipmentColumns.some((column) => column === field)) {
        values[field] = choice.kind === "none" ? null : choice.value;
        provenance[field] = choice.id;
      }
    if (typeof values.name !== "string") {
      c.gap.evidence("an accepted package header", "agent");
      return c.done();
    }
    for (const [field, entity] of [
      ["purchaseId", "purchase"],
      ["carrierId", "vendor"],
    ] as const)
      if (typeof values[field] === "string")
        values[field] = c.reference(entity, values[field]);
    c.record(shipmentRecords, key, values, {
      authored: observations.some((row) => row.manual),
      provenance,
    });
    return c.done();
  },
});
