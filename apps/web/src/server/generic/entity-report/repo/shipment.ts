import type { ReportBlock } from "@cubby/schemas/entity-report";
import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";

import type { Database } from "~/server/db";
import { readShipmentTimeline } from "~/server/domains/shipment/repo/timeline";

const timeLabel = (event: ShipmentObservationInput) => {
  switch (event.time.kind) {
    case "unknown":
      return "Time unknown";
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
          timeLabel(row.event),
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
          timeLabel(row),
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
