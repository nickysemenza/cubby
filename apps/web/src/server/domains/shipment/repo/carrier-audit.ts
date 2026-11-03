import {
  shortcodeSchema,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { SHIPMENT_IDENTITY_PERIOD_DAYS } from "@cubby/schemas/shipment-fields";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  shipment,
  vendor,
  shipmentSourceCapture,
  shipmentSourcePackage,
} from "~/server/db/retained-tables";
import {
  assessCarrierPacket,
  carrierCaptureEvidence,
  carrierClaimsConflict,
  loadCarrierHistory,
  carrierFormatEvidence,
  normalizeCarrierReference,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { shipmentCarrierEvidence } from "~/server/domains/shipment/repo/carrier-packets";
import { loadReceiptFieldAuthority } from "~/server/generic/assessment/repo/automatic-fields";

export const auditShipmentCarriersInput = z.strictObject({
  scope: z.enum(["shipments", "unresolved"]).default("shipments"),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
const auditShipmentCarriersOut = z.object({
  next: z.uuid().nullable(),
  coverage: z.object({
    inspected: z.number(),
    retainedPackets: z.number(),
    historicalUnindexedCaptures: z.number(),
    shipmentsWithoutPackets: z.number(),
    packetLimitReached: z.boolean(),
    complete: z.boolean(),
  }),
  candidates: z.array(
    z.object({
      shipmentId: shortcodeSchema("shipment").nullable(),
      captureId: z.uuid().nullable(),
      sourceReference: z.string().nullable(),
      formats: z.array(
        z.object({
          outcome: z.string(),
          carriers: z.array(z.string()),
          sources: z.array(z.string()),
        }),
      ),
      category: z.enum([
        "correction_eligible",
        "conflicting_or_handoff",
        "insufficient_evidence",
        "unknown_authority",
        "member_decision",
        "consistent",
      ]),
      reason: z.string(),
    }),
  ),
});

type AuditCategory = z.infer<
  typeof auditShipmentCarriersOut
>["candidates"][number]["category"];

function carrierAuditCategory(input: {
  row: typeof shipment.$inferSelect | undefined;
  result: Awaited<ReturnType<typeof assessCarrierPacket>>;
  history: Awaited<ReturnType<typeof loadCarrierHistory>> | undefined;
  authority: Awaited<ReturnType<typeof loadReceiptFieldAuthority>> | undefined;
  packetLimitReached: boolean;
  trackingNumber: string | null;
}): AuditCategory {
  const { row, result, history, authority, packetLimitReached } = input;
  const carrier = result.primary.carrier;
  const conflict = carrierClaimsConflict([
    ...result.explicit,
    ...(history?.claims ?? []),
  ]);
  const samePrimary =
    row?.trackingNumber &&
    input.trackingNumber &&
    normalizeCarrierReference(row.trackingNumber) ===
      normalizeCarrierReference(input.trackingNumber);
  const category =
    conflict || (row && carrier && !samePrimary)
      ? "conflicting_or_handoff"
      : authority?.kind === "member"
        ? "member_decision"
        : row && authority?.kind !== "automatic"
          ? "unknown_authority"
          : !row || !carrier || packetLimitReached || history?.truncated
            ? "insufficient_evidence"
            : row.carrierId === carrier.id
              ? "consistent"
              : "correction_eligible";
  return category;
}

/** SELECT-only, stable id pagination. Both scopes must be exhausted to claim population coverage. */
export async function auditShipmentCarriers(
  db: Database,
  raw: z.input<typeof auditShipmentCarriersInput>,
): Promise<z.infer<typeof auditShipmentCarriersOut>> {
  const input = auditShipmentCarriersInput.parse(raw);
  const database = getDb(db);
  const candidates: z.infer<typeof auditShipmentCarriersOut>["candidates"] = [];
  const rows =
    input.scope === "shipments"
      ? await database
          .select()
          .from(shipment)
          .where(
            and(
              notDeleted(shipment),
              input.after
                ? gt(shipment.id, parseEntityId("shipment", input.after))
                : undefined,
            ),
          )
          .orderBy(asc(shipment.id))
          .limit(input.limit + 1)
      : [];
  const carrierIds = rows
    .map((row) => row.carrierId)
    .filter((id) => id !== null);
  const knownCarriers = carrierIds.length
    ? await database
        .select({ id: vendor.id, name: vendor.name, aliases: vendor.aliases })
        .from(vendor)
        .where(inArray(vendor.id, carrierIds))
    : [];
  const packets = await database
    .select({
      id: shipmentCarrierEvidence.id,
      packet: shipmentCarrierEvidence.packet,
      captureId: shipmentSourceCapture.id,
      source: shipmentSourceCapture.source,
      originalContent: shipmentSourceCapture.originalContent,
      shipmentId: shipmentSourcePackage.shipmentId,
    })
    .from(shipmentCarrierEvidence)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentCarrierEvidence.captureId),
    )
    .leftJoin(
      shipmentSourcePackage,
      and(
        eq(shipmentSourcePackage.sourceKey, shipmentSourceCapture.sourceKey),
        eq(
          shipmentSourcePackage.packageKey,
          shipmentCarrierEvidence.packageKey,
        ),
      ),
    )
    .where(
      input.scope === "unresolved"
        ? and(
            sql`${shipmentSourcePackage.id} IS NULL`,
            input.after
              ? gt(shipmentCarrierEvidence.id, input.after)
              : undefined,
          )
        : sql`${shipmentSourcePackage.shipmentId} = ANY(${uuidArrayParam(rows.slice(0, input.limit).map((row) => row.id))})`,
    )
    .orderBy(asc(shipmentCarrierEvidence.id))
    .limit(input.scope === "unresolved" ? input.limit + 1 : 2001);
  // Bound packet hydration as well as Shipment paging; report incomplete coverage explicitly.
  const selected = packets.slice(
    0,
    input.scope === "unresolved" ? input.limit : 2000,
  );
  const assessments = [];
  for (const item of selected)
    assessments.push({
      item,
      result: await assessCarrierPacket(
        db,
        item.packet,
        carrierCaptureEvidence(item),
      ),
    });
  const histories = new Map<
    string,
    Awaited<ReturnType<typeof loadCarrierHistory>>
  >();
  for (const row of rows.slice(0, input.limit))
    histories.set(
      row.id,
      await loadCarrierHistory(db, {
        shipmentId: row.id,
        references: [
          row.trackingNumber,
          ...row.extraTrackingNumbers.map((ref) => ref.trackingNumber),
        ].filter((number) => number !== null),
      }),
    );
  const authorities = new Map<
    string,
    Awaited<ReturnType<typeof loadReceiptFieldAuthority>>
  >();
  for (const row of rows.slice(0, input.limit))
    authorities.set(
      row.id,
      await loadReceiptFieldAuthority(
        db,
        "shipment",
        row.id,
        "carrierId",
        row.carrierId,
      ),
    );
  for (const { item, result } of assessments) {
    const row = rows.find((row) => row.id === item.shipmentId);
    const carrier = result.primary.carrier;
    const history = row ? histories.get(row.id) : undefined;
    const authority = row ? authorities.get(row.id) : undefined;
    let category = carrierAuditCategory({
      row,
      result,
      history,
      authority,
      packetLimitReached: packets.length > 2000,
      trackingNumber: item.packet.trackingNumber,
    });
    if (category === "correction_eligible" && row && carrier) {
      const identity =
        // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- carrier is the existing identity JSON key, not an enum value.
        await database.execute(sql`SELECT id FROM shipment_identity_candidates(
        jsonb_build_array(jsonb_build_object('trackingNumber', ${row.trackingNumber}::text, 'carrier', shipment_carrier_key(${carrier.code}::text))),
        ${history?.window.first ?? null}::date, ${history?.window.last ?? null}::date) WHERE id <> ${row.id}::uuid AND NOT carrier_conflict LIMIT 1`);
      if (identity.rows.length) category = "conflicting_or_handoff";
      else if (
        !history?.window.first ||
        !history.window.last ||
        Date.parse(history.window.last) - Date.parse(history.window.first) >
          SHIPMENT_IDENTITY_PERIOD_DAYS * 86400000
      )
        category = "insufficient_evidence";
    }
    candidates.push({
      shipmentId: row ? parseShortcodeFor("shipment", row.shortcode) : null,
      captureId: item.captureId,
      sourceReference:
        item.source.kind === "email"
          ? item.source.emailId
          : item.source.kind === "tracking_page"
            ? item.source.url
            : item.source.fileName,
      category,
      reason:
        category === "correction_eligible"
          ? "Supported candidate only; application must revalidate all retained claims, current authority and identity collisions atomically."
          : category.replaceAll("_", " "),
      formats: [
        item.packet.trackingNumber,
        ...item.packet.extraTrackingNumbers.map((ref) => ref.trackingNumber),
      ]
        .filter((number) => number !== null)
        .map((number) => {
          const named = result.forReference(number).carrier;
          return carrierFormatEvidence(
            number,
            named ? [named.name, ...named.aliases] : [],
          );
        }),
    });
  }
  for (const row of rows.slice(0, input.limit)) {
    if (!selected.some((item) => item.shipmentId === row.id))
      candidates.push({
        shipmentId: parseShortcodeFor("shipment", row.shortcode),
        captureId: null,
        sourceReference: null,
        category:
          authorities.get(row.id)?.kind === "member"
            ? "member_decision"
            : authorities.get(row.id)?.kind === "unknown"
              ? "unknown_authority"
              : "insufficient_evidence",
        reason:
          "No retained carrier packet in this bounded page; older captures/observations remain preserved and require source review.",
        formats: row.trackingNumber
          ? [
              carrierFormatEvidence(
                row.trackingNumber,
                knownCarriers
                  .filter((carrier) => carrier.id === row.carrierId)
                  .flatMap((carrier) => [carrier.name, ...carrier.aliases]),
              ),
            ]
          : [],
      });
  }
  const gaps = await database.execute(
    sql`SELECT count(*)::int AS count FROM ${shipmentSourceCapture} WHERE NOT EXISTS (SELECT 1 FROM ${shipmentCarrierEvidence} WHERE ${shipmentCarrierEvidence.captureId} = ${shipmentSourceCapture.id})`,
  );
  const historicalUnindexedCaptures = z
    .object({ count: z.number() })
    .parse(gaps.rows[0]).count;
  const shipmentsWithoutPackets = rows
    .slice(0, input.limit)
    .filter(
      (row) => !selected.some((packet) => packet.shipmentId === row.id),
    ).length;
  const population = input.scope === "shipments" ? rows : packets;
  return {
    next:
      population.length > input.limit
        ? (population[input.limit - 1]?.id ?? null)
        : null,
    coverage: {
      inspected: Math.min(input.limit, population.length),
      retainedPackets: selected.length,
      historicalUnindexedCaptures,
      shipmentsWithoutPackets,
      packetLimitReached: input.scope === "shipments" && packets.length > 2000,
      complete:
        historicalUnindexedCaptures === 0 &&
        shipmentsWithoutPackets === 0 &&
        population.length <= input.limit &&
        (input.scope === "unresolved" || packets.length <= 2000),
    },
    candidates,
  };
}
