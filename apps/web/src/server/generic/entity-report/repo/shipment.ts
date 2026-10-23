import type {
  ReportBlock,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { inArray } from "drizzle-orm";

import { formatTimestamp } from "~/lib/date-format";
import { formatDateSpan } from "~/lib/date-span";
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

const timeLabel = (event: ShipmentObservationInput, reportedAt?: string) => {
  switch (event.time.kind) {
    case "unknown":
      return reportedAt
        ? `${formatTimestamp(reportedAt)} (Email received; event time unknown)`
        : "Time unknown";
    case "local":
      return `${event.time.value} (${event.time.timezone ?? "timezone unknown"})`;
    case "date":
      return `${formatDateSpan(event.time.value, null)} (date only)`;
    case "instant":
      return formatTimestamp(event.time.value);
  }
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
      rows: report.timeline
        .map((row): ReportRecordRow => {
          const sources = row.observationIds.flatMap((id) => {
            const observation = observations.get(id);
            return observation ? [observation] : [];
          });
          const reportedAt = sources
            .flatMap((source) => {
              const received = reportingTime(source);
              return received ? [received] : [];
            })
            .sort()[0];
          const at =
            row.event.time.kind === "instant"
              ? row.event.time.value
              : row.event.time.kind === "unknown"
                ? reportedAt
                : undefined;
          const page = sources.find(
            (source) => source.source.kind === "tracking_page",
          )?.source;
          return {
            entity: null,
            id: null,
            key: row.observationIds.join(":"),
            title: row.event.rawStatus,
            trailing: at ? null : timeLabel(row.event),
            ...(at ? { at } : {}),
            showRelativeTime: true,
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
              ...(row.event.time.kind === "unknown" && reportedAt
                ? [{ text: "Email received; event time unknown" }]
                : []),
              ...sources.flatMap((source) =>
                source.source.kind === "email"
                  ? [{ text: source.source.emailId }]
                  : [],
              ),
            ],
            ...(page?.kind === "tracking_page"
              ? { externalLink: { label: "Carrier tracking", url: page.url } }
              : {}),
          } satisfies ReportRecordRow;
        })
        .sort(
          (a, b) =>
            (a.at ? Date.parse(a.at) : Infinity) -
            (b.at ? Date.parse(b.at) : Infinity),
        ),
    },
    {
      kind: "table",
      title: "Retained observations",
      columns: ["When", "Status", "Report", "Source", "History"],
      empty: "No source evidence recorded.",
      rows: report.observations.map((row) => ({
        id: row.observationId,
        cells: [
          timeLabel(row, reportingTime(row)),
          eventLabels[row.kind],
          row.rawStatus,
          row.source.kind === "email" ? row.source.emailId : row.source.url,
          `${row.superseded ? "Superseded · " : ""}First seen ${formatTimestamp(row.firstSeenAt)} · Last seen ${formatTimestamp(row.lastSeenAt)}`,
        ],
        ...(row.source.kind === "email"
          ? {
              presentation: {
                "3": {
                  kind: "links",
                  links: [
                    {
                      label: row.source.emailId,
                      href: `/emails/${row.source.emailId}`,
                    },
                  ],
                },
              },
            }
          : {}),
      })),
    },
  ];
}
