import type {
  ReportBlock,
  ReportRecordRow,
  ReportTime,
} from "@cubby/schemas/entity-report";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { inArray } from "drizzle-orm";

import { formatTimestamp } from "~/lib/date-format";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { email } from "~/server/db/schema";
import { readShipmentTimeline } from "~/server/domains/shipment/repo/timeline";

const eventLabels = {
  label_created: "Label created",
  vendor_shipped: "Seller reported shipped",
  carrier_possession: "Carrier possession",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivery_attempt: "Delivery attempted",
  delivered: "Delivered",
  exception: "Exception",
  returned: "Returned",
  cancelled: "Cancelled",
  unknown: "Unknown",
} satisfies Record<ShipmentObservationInput["kind"], string>;

const eventTime = (
  event: ShipmentObservationInput,
  receiptAt?: string,
): ReportTime =>
  event.time.kind === "unknown"
    ? { kind: "unknown", ...(receiptAt ? { receiptAt } : {}) }
    : event.time;

const sourceLines = (
  rows: Awaited<ReturnType<typeof readShipmentTimeline>>["observations"],
): NonNullable<ReportRecordRow["lines"]> => {
  const lines = new Map<
    string,
    NonNullable<ReportRecordRow["lines"]>[number]
  >();
  for (const { source, sourceCaptureId } of rows) {
    if (source.kind === "email")
      lines.set(source.emailId, {
        text: source.emailId,
        ref: { entity: "email", id: source.emailId },
      });
    else if (source.kind === "tracking_page")
      lines.set(source.url, { text: "Carrier tracking", url: source.url });
    else
      lines.set(sourceCaptureId, {
        text: `SMS from ${source.sender} · ${source.fileName}`,
      });
  }
  return [...lines.values()];
};

export async function shipmentTrackingReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const report = await readShipmentTimeline(db, code);
  const emailCodes = [
    ...new Set(
      report.observations.flatMap((row) =>
        row.source.kind === "email" ? [row.source.emailId] : [],
      ),
    ),
  ];
  const received = emailCodes.length
    ? await getDb(db)
        .select({ code: email.shortcode, receivedAt: email.receivedAt })
        .from(email)
        .where(inArray(email.shortcode, emailCodes))
    : [];
  const receivedAt = new Map(
    received.map((row) => [row.code, row.receivedAt?.toISOString()]),
  );
  const reportingTime = (row: (typeof report.observations)[number]) =>
    row.source.kind === "email"
      ? receivedAt.get(row.source.emailId)
      : undefined;
  const observations = new Map(
    report.observations.map((row) => [row.observationId, row]),
  );
  return [
    {
      kind: "records",
      presentation: "timeline",
      empty: "No tracking observations recorded.",
      // Preserve the reconciler's ordering; receipt fallbacks are not carrier event times.
      rows: report.timeline.map((row): ReportRecordRow => {
        const sources = row.observationIds.flatMap((id) => {
          const observation = observations.get(id);
          return observation ? [observation] : [];
        });
        const reportedAt = sources
          .flatMap((source) => {
            const receipt = reportingTime(source);
            return receipt ? [receipt] : [];
          })
          .sort()[0];
        return {
          entity: null,
          id: null,
          key: row.observationIds.join(":"),
          title: row.event.rawStatus,
          trailing: null,
          time: eventTime(row.event, reportedAt),
          state: {
            kind: row.event.kind === "exception" ? "warning" : "done",
            label: eventLabels[row.event.kind],
          },
          badges: [
            {
              label: eventLabels[row.event.kind],
              tone: row.event.kind === "exception" ? "warning" : "muted",
            },
          ],
          lines: [
            ...(row.event.location ? [{ text: row.event.location }] : []),
            ...sourceLines(sources),
          ],
        };
      }),
    },
    {
      kind: "records",
      disclosureLabel: `Retained observations (${report.observations.length})`,
      empty: "No source evidence recorded.",
      rows: report.observations.map((row): ReportRecordRow => ({
        entity: null,
        id: null,
        key: row.observationId,
        title: row.rawStatus,
        trailing: null,
        time: eventTime(row, reportingTime(row)),
        badges: [
          {
            label: eventLabels[row.kind],
            tone: row.kind === "exception" ? "warning" : "muted",
          },
          ...(row.superseded
            ? [{ label: "Superseded", tone: "muted" as const }]
            : []),
        ],
        lines: [
          ...(row.location ? [{ text: row.location }] : []),
          ...sourceLines([row]),
          {
            text: `First seen ${formatTimestamp(row.firstSeenAt)} · Last seen ${formatTimestamp(row.lastSeenAt)}`,
            tone: "muted",
          },
        ],
      })),
    },
  ];
}
