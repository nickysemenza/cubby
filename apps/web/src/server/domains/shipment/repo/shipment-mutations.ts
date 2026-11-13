import { systemActor, type ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, isTransaction } from "~/server/db/helpers";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { shipment } from "~/server/db/schema";
import { jsonSnapshot } from "~/server/lib/canonical-json";

/** An accepted package projection is retained before its reconciler publishes a Shipment. */
export async function appendShipmentHeader(
  db: Database,
  input: {
    values: Partial<typeof shipment.$inferInsert>;
    shipmentId?: string;
    scopeKey?: string;
    sourceKey: string;
    packageKey: string;
    manual?: boolean;
  },
  actor: ActorContext = systemActor(),
) {
  const { append, evidenceRow, householdWrite, reconcileNow, recordIdentity } =
    await import("~/server/kernel/api");
  const { shipmentPackageEvidence } =
    await import("~/server/domains/shipment/repo/shipment-event");
  return householdWrite(db, async (database) => {
    const q = repositoryQueries(database);
    const [owner] = input.shipmentId
      ? await q
          .select()
          .from(recordKey)
          .where(
            and(
              eq(recordKey.entity, "shipment"),
              eq(recordKey.entityId, input.shipmentId),
            ),
          )
      : [];
    if (input.shipmentId && !owner)
      throw new Error("Shipment has no reconciliation scope");
    const key =
      owner?.scopeKey ??
      input.scopeKey ??
      `${input.sourceKey}:${input.packageKey}`;
    const values = jsonSnapshot.parse(
      Object.fromEntries(
        Object.entries(input.values).filter(
          ([field, value]) =>
            value !== undefined &&
            ![
              "id",
              "shortcode",
              "createdAt",
              "updatedAt",
              "deletedAt",
            ].includes(field),
        ),
      ),
    );
    const id = recordIdentity(
      { kind: "shipment", key },
      "ShipmentPackageObservation",
      JSON.stringify({
        sourceKey: input.sourceKey,
        packageKey: input.packageKey,
        values,
      }),
    );
    await append(database, [
      evidenceRow(shipmentPackageEvidence, {
        id,
        scopeKey: key,
        sourceKey: input.sourceKey,
        packageKey: input.packageKey,
        actorUserId: actor.userId,
        values,
        manual: input.manual ?? false,
      }),
    ]);
    const [outcome] = await reconcileNow(database, [{ kind: "shipment", key }]);
    const [owned] = await q
      .select()
      .from(recordKey)
      .where(
        and(
          eq(recordKey.entity, "shipment"),
          eq(recordKey.scopeKind, "shipment"),
          eq(recordKey.scopeKey, key),
        ),
      );
    if (!owned)
      throw new Error(
        outcome?.error ??
          outcome?.gaps[0]?.input ??
          "Accepted package has no Shipment",
      );
    const [row] = await q
      .select()
      .from(shipment)
      .where(eq(shipment.id, parseEntityId("shipment", owned.entityId)));
    if (!row) throw new Error("Reconciled Shipment is missing");
    return row;
  });
}

/** Every member field edit uses the same decision precedence as later package evidence. */
export async function updateShipmentWhere(
  db: Database | DrizzleTransaction,
  values: Partial<typeof shipment.$inferInsert>,
  where: SQL | undefined,
  actor: ActorContext = systemActor(),
) {
  const source = isTransaction(db) ? databaseForTransaction(db) : db;
  const { householdWrite, decide, reconcileNow, recordSubject } =
    await import("~/server/kernel/api");
  const { shipmentColumns } =
    await import("~/server/domains/shipment/repo/shipment-event");
  return householdWrite(source, async (database) => {
    const q = repositoryQueries(database);
    const rows = await q.select().from(shipment).where(where);
    const owners = rows.length
      ? await q
          .select()
          .from(recordKey)
          .where(
            and(
              eq(recordKey.entity, "shipment"),
              inArray(
                recordKey.entityId,
                rows.map((row) => row.id),
              ),
            ),
          )
      : [];
    if (rows.some((row) => !owners.some((owner) => owner.entityId === row.id)))
      throw new Error("Shipment has no reconciliation scope");
    if (actor.channel === "system" || actor.runId) {
      const { append, evidenceRow, recordIdentity } =
        await import("~/server/kernel/api");
      const { shipmentPackageEvidence } =
        await import("~/server/domains/shipment/repo/shipment-event");
      const observed = jsonSnapshot.parse(
        Object.fromEntries(
          Object.entries(values).filter(
            ([field, value]) =>
              value !== undefined &&
              shipmentColumns.some((column) => column === field),
          ),
        ),
      );
      await append(
        database,
        rows.map((row) => {
          const owner = owners.find((owner) => owner.entityId === row.id)!;
          return evidenceRow(shipmentPackageEvidence, {
            id: recordIdentity(
              { kind: "shipment", key: owner.scopeKey },
              "ShipmentPackageObservation",
              JSON.stringify(observed),
            ),
            scopeKey: owner.scopeKey,
            sourceKey: `projection:${owner.scopeKey}`,
            packageKey: "header",
            actorUserId: actor.userId,
            values: observed,
          });
        }),
      );
    } else
      await decide(
        database,
        actor,
        rows.flatMap((row) =>
          Object.entries(values)
            .filter(
              ([field, value]) =>
                value !== undefined &&
                shipmentColumns.some((column) => column === field),
            )
            .map(([field, value]) => ({
              channel: "assignment" as const,
              kind: value === null ? ("none" as const) : ("set" as const),
              subject: recordSubject("shipment", row.id),
              field,
              value: jsonSnapshot.parse(value),
            })),
        ),
      );
    const authored = Object.fromEntries(
      Object.entries(values).filter(
        ([field, value]) =>
          value !== undefined &&
          !shipmentColumns.some((column) => column === field),
      ),
    );
    if (Object.keys(authored).length && rows.length)
      await q
        .update(shipment)
        .set(authored)
        .where(
          inArray(
            shipment.id,
            rows.map((row) => row.id),
          ),
        );
    await reconcileNow(
      database,
      owners.map((owner) => ({ kind: owner.scopeKind, key: owner.scopeKey })),
    );
    return rows.length
      ? q
          .select()
          .from(shipment)
          .where(
            inArray(
              shipment.id,
              rows.map((row) => row.id),
            ),
          )
      : [];
  });
}
