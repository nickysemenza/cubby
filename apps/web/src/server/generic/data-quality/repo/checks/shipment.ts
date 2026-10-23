import { sql } from "drizzle-orm";

import { shipment } from "~/server/db/schema";
import { shipmentQualityFacts } from "~/server/domains/shipment/repo/quality";
import {
  defineEntityChecks,
  qualityReadColumn,
  type QualityReadContext,
} from "~/server/generic/data-quality/repo/registry";

type Shipment = typeof shipment;
type Fact =
  | "eventCount"
  | "shipped"
  | "delivered"
  | "milestoneDates"
  | "extendedSpan"
  | "chronology";
const fact = (t: Shipment, key: Fact, context?: QualityReadContext) =>
  qualityReadColumn(context, key) ??
  sql`(SELECT f.${sql.identifier(key)} FROM (${shipmentQualityFacts(sql`ARRAY[${t.id}]::uuid[]`)}) f)`;

export const shipmentChecks = defineEntityChecks({
  entity: "shipment",
  table: shipment,
  derivedRead: (ids) => shipmentQualityFacts(ids),
  filterRead: () => shipmentQualityFacts(),
  checks: {
    shipment_event_count: {
      missing: (t: Shipment, ctx) =>
        sql`coalesce(${fact(t, "eventCount", ctx)}, 0) < 2`,
    },
    shipment_shipped: {
      missing: (t: Shipment, ctx) =>
        sql`NOT coalesce(${fact(t, "shipped", ctx)}, false)`,
    },
    shipment_delivered: {
      missing: (t: Shipment, ctx) =>
        sql`NOT coalesce(${fact(t, "delivered", ctx)}, false)`,
    },
    shipment_event_span: {
      missing: (t: Shipment, ctx) =>
        sql`NOT coalesce(${fact(t, "extendedSpan", ctx)}, false)`,
    },
    shipment_milestone_dates: {
      missing: (t: Shipment, ctx) =>
        sql`NOT coalesce(${fact(t, "milestoneDates", ctx)}, false)`,
    },
    shipment_chronology: {
      missing: (t: Shipment, ctx) =>
        sql`NOT coalesce(${fact(t, "chronology", ctx)}, true)`,
    },
  },
});
