-- Plain reads are invisible to the runner's lock detection. Every table this
-- block reads or writes is named here.
LOCK TABLE "ScopeDep", "ScopeDirty" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Email state owner and link keys.
--
-- emailState reads the Purchases owning its bound order observations through
-- each owning purchaseEvent scope's `owned:<kind>:<key>` key instead of the
-- RecordKey and Purchase column keys, and fences the link decisions other
-- Emails record on its order events through `index:decisionLink.event:<id>`
-- and their subjects' decision keys. Stored emailState dependencies predate
-- both, so every emailState scope that has published is made dirty the way
-- markDirty dirties a scope on a new input (seq raised, so a claim loaded
-- before this migration cannot publish; attempts and wait cleared). Its next
-- publication replaces its dependencies; the old rows stay until then and
-- only over-dirty. A scope with no ScopeDep rows has never published.
DO $$
DECLARE
  dep_scopes bigint;
  dirty_before bigint;
  dirty_after bigint;
BEGIN
  CREATE TEMP TABLE email_state_owner_scopes ON COMMIT DROP AS
    SELECT DISTINCT "scopeKey" FROM "ScopeDep" WHERE "scopeKind" = 'emailState';
  SELECT count(*) INTO dep_scopes FROM email_state_owner_scopes;
  SELECT count(*) INTO dirty_before FROM "ScopeDirty" WHERE "scopeKind" = 'emailState';

  INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason)
  SELECT 'emailState', "scopeKey", 'money', 'email state owner keys'
  FROM email_state_owner_scopes
  ORDER BY "scopeKey"
  ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
    seq = "ScopeDirty".seq + 1,
    reason = excluded.reason,
    attempts = 0,
    "availableAt" = LEAST("ScopeDirty"."availableAt", now()),
    "waitCause" = NULL,
    "updatedAt" = now();

  IF EXISTS (
    SELECT 1 FROM email_state_owner_scopes s WHERE NOT EXISTS (
      SELECT 1 FROM "ScopeDirty" d
      WHERE d."scopeKind" = 'emailState' AND d."scopeKey" = s."scopeKey"
        AND d.attempts = 0 AND d."waitCause" IS NULL AND d."availableAt" <= now())
  ) THEN
    RAISE EXCEPTION 'emailState owner keys: a published scope is not claimable';
  END IF;
  SELECT count(*) INTO dirty_after FROM "ScopeDirty" WHERE "scopeKind" = 'emailState';
  RAISE NOTICE 'emailState owner keys: % published scopes, dirty % -> %',
    dep_scopes, dirty_before, dirty_after;
END $$;
