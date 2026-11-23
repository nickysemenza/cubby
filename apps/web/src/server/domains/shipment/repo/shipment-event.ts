import {
  shipmentPurpose,
  shipmentExtraTrackingNumbers,
} from "@cubby/schemas/shipment-fields";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { shipment, shipmentPackageObservation } from "~/server/db/schema";
import {
  defineEvidence,
  defineReconciler,
  recordIdentity,
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
const shipmentRecords = writes(shipment, shipmentColumns, {
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

const SHIPMENT_SCOPE = "shipment";

/** Accepted, normalized package headers and member decisions fill a single Shipment identity. */
export const shipmentEvent = defineReconciler<Input>({
  scope: SHIPMENT_SCOPE,
  lane: "money",
  version: 1,
  after: ["purchaseEvent"],
  reads: [
    source.evidence(shipmentPackageEvidence),
    source.table(shipment, [...shipmentColumns, "deletedAt"]),
  ],
  writes: [shipmentRecords],
  async load(reads, keys) {
    // A scope reads only its own Shipment: the records it owns, or the one it
    // would create. Its RecordKey rows change only through its own
    // publication or a kernel merge or rejection, which dirties it.
    const owned = await reads.prepare([], async (database) =>
      repositoryQueries(database)
        .select({ key: recordKey.scopeKey, id: recordKey.entityId })
        .from(recordKey)
        .where(
          sql`${recordKey.scopeKind} = ${SHIPMENT_SCOPE} AND ${recordKey.scopeKey} = ANY(${textArrayParam(keys)})`,
        ),
    );
    const loaded = await Promise.all(
      keys.map((key) => {
        const scoped = reads.for(key);
        return Promise.all([
          scoped.facts(shipmentPackageEvidence, [`shipment:${key}`]),
          scoped.rows(shipment, [
            ...owned.filter((row) => row.key === key).map((row) => row.id),
            recordIdentity(
              { kind: SHIPMENT_SCOPE, key },
              shipmentRecords.name,
              "shipment",
            ),
          ]),
        ]);
      }),
    );
    return new Map(
      keys.map((key, index) => {
        const [observations, rows] = loaded[index]!;
        return [
          key,
          {
            key,
            observations: observations.get(`shipment:${key}`) ?? [],
            rows: [...rows.values()],
          },
        ];
      }),
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
