/* oxlint-disable cubby/no-raw-deleted-at-predicate -- Desired-state PostgreSQL functions own live-row predicates. */
/** Shipment identity uses source-event days, never intake or cache timestamps. */
export function shipmentIdentityDdl(): string {
  return `CREATE OR REPLACE FUNCTION shipment_event_day(event jsonb) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF event->>'timeBasis' = 'estimate' THEN RETURN NULL; END IF;
  IF event->'time'->>'kind' = 'instant' THEN
    RETURN ((event->'time'->>'value')::timestamptz AT TIME ZONE 'America/Los_Angeles')::date;
  ELSIF event->'time'->>'kind' IN ('date', 'local') AND
      event->'time'->>'value' ~ '^\\d{4}-\\d{2}-\\d{2}($|T)' THEN
    RETURN left(event->'time'->>'value', 10)::date;
  END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION shipment_carrier_key(code text) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE identities AS (
    SELECT id, "mergedIntoId" FROM "Entity" WHERE shortcode = code AND kind = 'vendor'
    UNION ALL
    SELECT e.id, e."mergedIntoId" FROM "Entity" e JOIN identities i ON e.id = i."mergedIntoId"
  ) SELECT id::text FROM identities WHERE "mergedIntoId" IS NULL LIMIT 1
$$;

CREATE OR REPLACE FUNCTION shipment_tracking_refs(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'trackingNumber', upper(regexp_replace(r.number, '[[:space:]]', '', 'g')),
    'carrier', shipment_carrier_key(r.carrier))), '[]'::jsonb)
  FROM "Shipment" s LEFT JOIN "Vendor" v ON v.id = s."carrierId"
  CROSS JOIN LATERAL (
    SELECT s."trackingNumber" AS number, v.shortcode AS carrier
    UNION ALL
    SELECT ref->>'trackingNumber', ref->>'carrierId'
    FROM jsonb_array_elements(s."extraTrackingNumbers") ref
  ) r WHERE s.id = p_id AND nullif(regexp_replace(r.number, '[[:space:]]', '', 'g'), '') IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION shipment_identity_window(p_id uuid)
RETURNS TABLE(first_day date, last_day date) LANGUAGE sql STABLE AS $$
  SELECT coalesce(min(shipment_event_day(o.event)), min(n.day)),
    coalesce(max(shipment_event_day(o.event)), max(n.day))
  FROM "ShipmentObservation" o
  JOIN "ShipmentSourceCapture" c ON c.id = o."sourceCaptureId"
  LEFT JOIN "Email" e ON e.id = c."emailId"
  CROSS JOIN LATERAL (SELECT CASE
    WHEN c.source->>'kind' = 'email' THEN (e."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date
    WHEN c.source->>'kind' = 'sms_export' THEN shipment_event_day(jsonb_build_object('time', c.source->'sentAt'))
    END AS day) n
  WHERE o."shipmentId" = p_id AND o."supersededById" IS NULL
$$;

CREATE OR REPLACE FUNCTION shipment_identity_candidates(p_refs jsonb, p_first date, p_last date)
RETURNS TABLE(id uuid, shortcode text, purchase_id uuid, first_day date, last_day date, carrier_conflict boolean)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.shortcode, s."purchaseId", w.first_day, w.last_day,
    bool_or(a->>'carrier' IS NOT NULL AND b->>'carrier' IS NOT NULL AND a->>'carrier' <> b->>'carrier')
      AND NOT coalesce(bool_or(a->>'carrier' = b->>'carrier'), false)
  FROM "Shipment" s
  CROSS JOIN LATERAL shipment_identity_window(s.id) w
  CROSS JOIN LATERAL jsonb_array_elements(shipment_tracking_refs(s.id)) a
  CROSS JOIN jsonb_array_elements(p_refs) b
  WHERE s."deletedAt" IS NULL AND a->>'trackingNumber' = b->>'trackingNumber'
    AND (p_first IS NULL OR w.first_day IS NULL OR
      (p_first <= w.last_day + 60 AND w.first_day <= p_last + 60))
  GROUP BY s.id, s.shortcode, s."purchaseId", w.first_day, w.last_day
$$;

CREATE OR REPLACE FUNCTION shipment_identity_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('shipment-evidence-intake', 0));
  -- Advisory locks alone cannot refresh REPEATABLE READ snapshots. Updating a
  -- shared row forces stale snapshots to abort instead of admitting duplicates.
  IF current_setting('cubby.shipment_identity_locked', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "ShipmentIdentityLock" (key, revision) VALUES ('tracking', 1)
      ON CONFLICT (key) DO UPDATE SET revision = "ShipmentIdentityLock".revision + 1;
    PERFORM set_config('cubby.shipment_identity_locked', txid_current()::text, true);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION shipment_identity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p_id uuid; ids uuid[]; refs jsonb; w record; other record;
BEGIN
  IF TG_TABLE_NAME = 'Shipment' THEN ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'UPDATE' THEN ids := ARRAY[NEW."shipmentId", OLD."shipmentId"];
  ELSIF TG_OP = 'DELETE' THEN ids := ARRAY[OLD."shipmentId"];
  ELSE ids := ARRAY[NEW."shipmentId"]; END IF;
  FOR p_id IN SELECT DISTINCT value FROM unnest(ids) value
  LOOP
    IF NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s.id = p_id AND s."deletedAt" IS NULL) THEN CONTINUE; END IF;
    refs := shipment_tracking_refs(p_id);
    IF jsonb_array_length(refs) = 0 THEN CONTINUE; END IF;
    SELECT * INTO w FROM shipment_identity_window(p_id);
    -- Explicit reassignment can leave an evidence-free historical shell.
    IF NOT EXISTS (SELECT 1 FROM "ShipmentObservation" WHERE "shipmentId" = p_id) THEN CONTINUE; END IF;
    IF w.first_day IS NULL OR w.last_day - w.first_day > 60 THEN
      RAISE EXCEPTION 'Shipment tracking identity requires source-event dates within 60 days' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO other FROM shipment_identity_candidates(refs, w.first_day, w.last_day)
      WHERE id <> p_id AND NOT carrier_conflict LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Shipment tracking identity conflicts with %; resolve or merge its retained evidence', other.shortcode
        USING ERRCODE = '23505', CONSTRAINT = 'Shipment_tracking_period_unique';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Shipment_identity_lock" ON "Shipment";
CREATE TRIGGER "Shipment_identity_lock" BEFORE INSERT OR UPDATE OR DELETE ON "Shipment"
  FOR EACH ROW EXECUTE FUNCTION shipment_identity_lock();
DROP TRIGGER IF EXISTS "ShipmentObservation_identity_lock" ON "ShipmentObservation";
CREATE TRIGGER "ShipmentObservation_identity_lock" BEFORE INSERT OR UPDATE OR DELETE ON "ShipmentObservation"
  FOR EACH ROW EXECUTE FUNCTION shipment_identity_lock();
DROP TRIGGER IF EXISTS "Shipment_tracking_period_unique" ON "Shipment";
CREATE CONSTRAINT TRIGGER "Shipment_tracking_period_unique" AFTER INSERT OR UPDATE ON "Shipment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipment_identity_check();
DROP TRIGGER IF EXISTS "ShipmentObservation_tracking_period_unique" ON "ShipmentObservation";
CREATE CONSTRAINT TRIGGER "ShipmentObservation_tracking_period_unique" AFTER INSERT OR UPDATE OR DELETE ON "ShipmentObservation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipment_identity_check();`;
}
