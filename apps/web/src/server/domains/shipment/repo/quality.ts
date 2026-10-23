import {
  shipmentEventKind,
  shipmentEventTime,
} from "@cubby/schemas/shipment-evidence";
import { HOUSEHOLD_TIMEZONE } from "@cubby/shared/client-constants";
import { sql, type SQL } from "drizzle-orm";

const instant = shipmentEventTime.options[0].shape.kind.value;
const date = shipmentEventTime.options[1].shape.kind.value;
const local = shipmentEventTime.options[2].shape.kind.value;
const kinds = shipmentEventKind.enum;
const movement = sql.join(
  [
    kinds.carrier_possession,
    kinds.in_transit,
    kinds.out_for_delivery,
    kinds.delivery_attempt,
  ].map((kind) => sql`${kind}`),
  sql`, `,
);

/** Same occurrence identity as reconcileShipmentTimeline; coarse times cannot prove duplicates. */
const occurrence = sql`CASE WHEN o.event->${"time"}->>${"kind"} = ${instant} THEN
  jsonb_build_array(o.event->>${"kind"},
    extract(epoch FROM date_trunc('milliseconds', (o.event->${"time"}->>'value')::timestamptz)),
    coalesce(o.event->>'carrierId', o.event->>'carrierName'),
    lower(regexp_replace(o.event->>${"location"}, '^\\s+|\\s+$', '', 'g')),
    upper(regexp_replace(o.event->>'trackingNumber', '\\s', '', 'g')),
    CASE WHEN o.event->>${"kind"} = ${kinds.unknown} THEN o.event->>'rawStatus' END)
  ELSE to_jsonb(o.id::text) END`;

/** One shared relation serves hydration, list filtering and sorting. No capture time fills gaps. */
export const shipmentQualityFacts = (ids?: SQL): SQL => {
  // oxlint-disable-next-line anti-slop/no-unsafe-sql-array-interpolation -- The quality runtime supplies a typed SQL UUID-array expression, never a JavaScript array.
  const scope = ids ? sql`AND s.id = ANY(${ids}::uuid[])` : sql``;
  return sql`
  WITH current_events AS (
    SELECT DISTINCT ON (o."shipmentId", ${occurrence})
      o."shipmentId", o.event
    FROM "ShipmentObservation" o
    INNER JOIN "Shipment" s ON s.id = o."shipmentId" AND s."deletedAt" IS NULL
    WHERE o."supersededById" IS NULL ${scope}
  ), normalized_events AS (
    SELECT "shipmentId", CASE
      WHEN event->${"time"}->>${"kind"} = ${local}
        AND event->${"time"}->>'value' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?Z?$'
        AND pg_input_is_valid(event->${"time"}->>'value', 'timestamp without time zone')
      THEN jsonb_set(event, '{time}', jsonb_build_object(${"kind"}::text, ${date}::text,
        'value', left(event->${"time"}->>'value', 10)))
      ELSE event END AS event
    FROM current_events
  ), dated_events AS (
    SELECT *, event->>${"kind"} AS kind, event->${"time"}->>${"kind"} AS precision,
      CASE event->${"time"}->>${"kind"}
        WHEN ${instant} THEN date_trunc('milliseconds', (event->${"time"}->>'value')::timestamptz)
        WHEN ${date} THEN (event->${"time"}->>'value')::date::timestamp AT TIME ZONE 'UTC'
      END AS anchor,
      CASE event->${"time"}->>${"kind"}
        WHEN ${instant} THEN ((event->${"time"}->>'value')::timestamptz AT TIME ZONE ${HOUSEHOLD_TIMEZONE})::date
        WHEN ${date} THEN (event->${"time"}->>'value')::date
      END AS day
    FROM normalized_events
  ), intervals AS (
    SELECT *,
      CASE WHEN precision = ${date} THEN day::timestamp AT TIME ZONE ${HOUSEHOLD_TIMEZONE} ELSE anchor END AS lower_bound,
      CASE WHEN precision = ${date} THEN (day + 1)::timestamp AT TIME ZONE ${HOUSEHOLD_TIMEZONE} ELSE anchor END AS upper_bound
    FROM dated_events
  ), aggregates AS (
    SELECT "shipmentId" AS "entityId", count(*) AS "eventCount",
      bool_or(kind IN (${movement})) AS shipped,
      bool_or(kind = ${kinds.delivered}) AS delivered,
      bool_or(kind IN (${movement}) AND day IS NOT NULL)
        AND bool_or(kind = ${kinds.delivered} AND day IS NOT NULL) AS "milestoneDates",
      count(day) AS dated_count, min(day) AS first_day, max(day) AS last_day,
      (array_agg(precision ORDER BY day, anchor) FILTER (WHERE day IS NOT NULL))[1] AS first_precision,
      (array_agg(precision ORDER BY day DESC, anchor DESC) FILTER (WHERE day IS NOT NULL))[1] AS last_precision,
      min(anchor) FILTER (WHERE precision = ${instant}) AS first_instant,
      max(anchor) FILTER (WHERE precision = ${instant}) AS last_instant
    FROM intervals GROUP BY "shipmentId"
  )
  SELECT a."entityId", a."eventCount", a.shipped, a.delivered, a."milestoneDates",
    CASE WHEN dated_count < 2 THEN false
      WHEN first_precision = ${date} OR last_precision = ${date} THEN last_day - first_day > 1
      ELSE extract(epoch FROM last_instant - first_instant) > 86400 END AS "extendedSpan",
    NOT EXISTS (
      SELECT 1 FROM intervals d JOIN intervals other ON other."shipmentId" = d."shipmentId"
      WHERE d."shipmentId" = a."entityId" AND d.kind = ${kinds.delivered}
        AND d.day IS NOT NULL AND other.day IS NOT NULL AND (
          (other.kind IN (${movement}) AND other.lower_bound = (
            SELECT min(m.lower_bound) FROM intervals m
            WHERE m."shipmentId" = d."shipmentId" AND m.kind IN (${movement})
          ) AND
            (d.upper_bound < other.lower_bound OR
             (d.upper_bound = other.lower_bound AND d.precision = ${date})))
          OR (other.kind = ${kinds.delivered} AND
            (d.upper_bound < other.lower_bound OR
             (d.upper_bound = other.lower_bound AND (d.precision = ${date} OR other.precision = ${date}))))
        )
    ) AS chronology
  FROM aggregates a`;
};
