import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";
import { inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { email } from "~/server/db/schema";
import { readShipmentTimeline } from "~/server/domains/shipment/repo/timeline";

const timeLabel = (event: ShipmentObservationInput, reportedAt?: string) => {
  switch (event.time.kind) {
    case "unknown":
      return reportedAt
        ? `${reportedAt} (Email received; event time unknown)`
        : "Time unknown";
    case "local":
      return `${event.time.value} (${event.time.timezone ?? "timezone unknown"})`;
    case "date":
      return `${event.time.value} (date only)`;
    case "instant":
      return event.time.value;
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
  const sourceLabel = (ids: string[]) =>
    [
      ...new Set(
        ids.flatMap((id) => {
          const source = observations.get(id)?.source;
          return source
            ? [source.kind === "email" ? source.emailId : source.url]
            : [];
        }),
      ),
    ].join(" · ");
  return [
    {
      kind: "table",
      columns: ["When", "Event", "Location", "Sources"],
      empty: "No tracking observations recorded.",
      rows: report.timeline.map((row, index) => ({
        id: `event-${index}`,
        cells: [
          timeLabel(
            row.event,
            row.observationIds
              .flatMap((id) => {
                const observation = observations.get(id);
                const received = observation
                  ? reportingTime(observation)
                  : undefined;
                return received ? [received] : [];
              })
              .sort()[0],
          ),
          row.event.rawStatus,
          row.event.location ?? "Unknown",
          sourceLabel(row.observationIds),
        ],
      })),
    },
    {
      kind: "table",
      title: "Retained observations",
      columns: ["When", "Report", "Source", "History"],
      empty: "No source evidence recorded.",
      rows: report.observations.map((row) => ({
        id: row.observationId,
        cells: [
          timeLabel(row, reportingTime(row)),
          row.rawStatus,
          row.source.kind === "email" ? row.source.emailId : row.source.url,
          `${row.superseded ? "Superseded · " : ""}First seen ${row.firstSeenAt} · Last seen ${row.lastSeenAt}`,
        ],
        ...(row.source.kind === "email"
          ? {
              presentation: {
                "2": {
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
