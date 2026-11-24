/** Keep the sweep's negative eligibility check valid across kernel writers. */
export const versionSweepDdl = () => `
CREATE FUNCTION cubby_begin_sweep_check(wanted jsonb, token uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  -- Wait out writers that might have looked at the previous rules vector.
  -- The exact scan runs in a later statement, after releasing this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('cubby:version-sweep-check', 0));
  INSERT INTO "Pass" (name, key, cursor, "cancelledAt")
  VALUES ('version.sweep', 'eligibility', jsonb_build_object('rules', wanted, 'token', token), now())
  ON CONFLICT (name, key) DO UPDATE SET cursor = excluded.cursor
  WHERE "Pass".cursor IS DISTINCT FROM jsonb_build_object('rules', wanted);
  RETURN FOUND;
END $$;

CREATE FUNCTION cubby_invalidate_sweep_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  checked jsonb;
  current_rules text;
  invalidates boolean;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cubby:version-sweep-check', 0));
  -- Under a fixed transaction snapshot a writer may not see the active check.
  -- The upsert invalidates it or raises a serialization failure in that case.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
    INSERT INTO "Pass" (name, key, cursor, "cancelledAt")
    VALUES ('version.sweep', 'eligibility', NULL, now())
    ON CONFLICT (name, key) DO UPDATE SET cursor = NULL;
    RETURN NULL;
  END IF;
  SELECT cursor INTO checked FROM "Pass" WHERE name = 'version.sweep' AND key = 'eligibility';
  IF checked IS NULL THEN RETURN NULL; END IF;

  IF TG_OP = 'TRUNCATE' THEN
    invalidates := true;
  ELSIF TG_TABLE_NAME = 'ScopeState' THEN
    current_rules := checked->'rules'->>NEW."scopeKind";
    invalidates := NEW.rules <> current_rules;
  ELSE
    current_rules := checked->'rules'->>OLD."scopeKind";
    -- Test each removed blocker independently. A concurrent write can remove
    -- the other blocker or make the state stale.
    IF TG_TABLE_NAME = 'Drift' THEN
      IF OLD.rules IS DISTINCT FROM current_rules THEN RETURN NULL; END IF;
    END IF;
    invalidates := EXISTS (SELECT 1 FROM "ScopeState" s
      WHERE s."scopeKind" = OLD."scopeKind" AND s."scopeKey" = OLD."scopeKey"
        AND s.rules <> current_rules);
  END IF;
  IF invalidates THEN
    UPDATE "Pass" SET cursor = NULL
    WHERE name = 'version.sweep' AND key = 'eligibility' AND cursor IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "ScopeState_invalidate_sweep_insert" AFTER INSERT ON "ScopeState"
FOR EACH ROW EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "ScopeState_invalidate_sweep_update" AFTER UPDATE OF "scopeKind", "scopeKey", rules ON "ScopeState"
FOR EACH ROW WHEN ((OLD."scopeKind", OLD."scopeKey", OLD.rules) IS DISTINCT FROM (NEW."scopeKind", NEW."scopeKey", NEW.rules))
EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "ScopeDirty_invalidate_sweep_delete" AFTER DELETE ON "ScopeDirty"
FOR EACH ROW EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "ScopeDirty_invalidate_sweep_update" AFTER UPDATE OF "scopeKind", "scopeKey" ON "ScopeDirty"
FOR EACH ROW WHEN ((OLD."scopeKind", OLD."scopeKey") IS DISTINCT FROM (NEW."scopeKind", NEW."scopeKey"))
EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "ScopeDirty_invalidate_sweep_truncate" AFTER TRUNCATE ON "ScopeDirty"
FOR EACH STATEMENT EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "Drift_invalidate_sweep_delete" AFTER DELETE ON "Drift"
FOR EACH ROW EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "Drift_invalidate_sweep_update" AFTER UPDATE OF "scopeKind", "scopeKey", rules ON "Drift"
FOR EACH ROW WHEN ((OLD."scopeKind", OLD."scopeKey", OLD.rules) IS DISTINCT FROM (NEW."scopeKind", NEW."scopeKey", NEW.rules))
EXECUTE FUNCTION cubby_invalidate_sweep_check();
CREATE TRIGGER "Drift_invalidate_sweep_truncate" AFTER TRUNCATE ON "Drift"
FOR EACH STATEMENT EXECUTE FUNCTION cubby_invalidate_sweep_check();
`;
