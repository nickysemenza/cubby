-- KeyRev holds only raised keys: an absent key reads 0. Neither a foreign key
-- nor a trigger references KeyRev, so TRUNCATE returns the storage inside this
-- transaction.
LOCK TABLE "KeyRev" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  rev_total bigint;
  rev_zero bigint;
  rev_after bigint;
  referenced bigint;
BEGIN
  SELECT count(*) INTO referenced FROM pg_constraint
    WHERE confrelid = '"KeyRev"'::regclass;
  IF referenced <> 0 THEN
    RAISE EXCEPTION 'KeyRev rebuild: % foreign keys reference KeyRev', referenced;
  END IF;
  SELECT count(*) INTO referenced FROM pg_trigger
    WHERE tgrelid = '"KeyRev"'::regclass AND NOT tgisinternal;
  IF referenced <> 0 THEN
    RAISE EXCEPTION 'KeyRev rebuild: % triggers on KeyRev', referenced;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE rev <= 0)
    INTO rev_total, rev_zero
  FROM "KeyRev";
  CREATE TEMP TABLE key_rev_raised ON COMMIT DROP AS
    SELECT key, rev FROM "KeyRev" WHERE rev > 0;
  TRUNCATE "KeyRev";
  INSERT INTO "KeyRev" (key, rev) SELECT key, rev FROM key_rev_raised ORDER BY key;
  SELECT count(*) INTO rev_after FROM "KeyRev";
  IF rev_after <> rev_total - rev_zero THEN
    RAISE EXCEPTION 'KeyRev rebuild: kept % rows, expected %',
      rev_after, rev_total - rev_zero;
  END IF;
  IF EXISTS (SELECT 1 FROM key_rev_raised k
    WHERE NOT EXISTS (SELECT 1 FROM "KeyRev" r WHERE r.key = k.key AND r.rev = k.rev)) THEN
    RAISE EXCEPTION 'KeyRev rebuild: a kept revision changed';
  END IF;
END $$;
--> statement-breakpoint
ANALYZE "KeyRev";
--> statement-breakpoint

-- Plain reads are invisible to the runner's lock detection. Every table this
-- block reads or writes is named here.
LOCK TABLE "ScopeDep", "ScopeDirty", "FactKey", "Purchase" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Email state dependency keys.
--
-- 1. Two Purchase read indexes are added: purchase.order (orderId) and
--    purchase.vendor (vendorId). Both columns can change through an authored
--    Purchase write, whose before image is the stored `index:Purchase` FactKey
--    membership, so every Purchase gets its rows here. Values match the
--    declarations exactly: one key per non-null orderId / vendorId, deleted
--    Purchases included. The other new indexes (EmailClassificationObservation
--    and SourceOrderObservation by emailId, OrderMailEvent by orderMailId,
--    RunOperation mail outcomes by target entity id) cover columns set once at
--    insert, so no write moves a row between their memberships and they store
--    nothing ahead of a row's first write.
--
-- 2. Every emailState ScopeDep row was registered under batch-wide keys:
--    batchmates' Email and Run rows, bindings and accounts, and declared
--    column keys of EmailClassificationObservation, SourceOrderObservation,
--    OrderMailEvent, RunOperation, EmailReadSnapshot, OrderMail, LedgerParty,
--    Purchase and RecordKey. Each emailState scope holding such rows is made
--    dirty the way markDirty dirties a scope on a new input (seq raised, so a
--    claim loaded before this migration cannot publish; attempts and wait
--    cleared, so an exhausted scope is claimable again) and all of its
--    ScopeDep rows are deleted.
--    A dirty scope needs no dependency edge to be rerun; its next publication
--    registers the per-Email keys, and an in-flight load is still refused by
--    the KeyRev fence on every key it read. A scope with no ScopeDep rows has
--    never published and is untouched.
DO $$
DECLARE
  purchases_ordered bigint;
  purchases_vendored bigint;
  order_rows bigint;
  vendor_rows bigint;
  dep_rows bigint;
  dep_scopes bigint;
  dirty_before bigint;
  dirty_after bigint;
BEGIN
  SELECT count(*) FILTER (WHERE "orderId" IS NOT NULL),
    count(*) FILTER (WHERE "vendorId" IS NOT NULL)
    INTO purchases_ordered, purchases_vendored
  FROM "Purchase";
  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT 'index:purchase.order:' || "orderId", 'index:Purchase', id::text
  FROM "Purchase" WHERE "orderId" IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT 'index:purchase.vendor:' || "vendorId"::text, 'index:Purchase', id::text
  FROM "Purchase" WHERE "vendorId" IS NOT NULL
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO order_rows FROM "FactKey"
    WHERE "factKind" = 'index:Purchase' AND key LIKE 'index:purchase.order:%';
  SELECT count(*) INTO vendor_rows FROM "FactKey"
    WHERE "factKind" = 'index:Purchase' AND key LIKE 'index:purchase.vendor:%';
  IF order_rows <> purchases_ordered OR vendor_rows <> purchases_vendored THEN
    RAISE EXCEPTION 'Purchase memberships: % order and % vendor rows for % and % Purchases',
      order_rows, vendor_rows, purchases_ordered, purchases_vendored;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Purchase" p WHERE p."orderId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "FactKey" f WHERE f."factKind" = 'index:Purchase'
        AND f."factId" = p.id::text AND f.key = 'index:purchase.order:' || p."orderId")
  ) OR EXISTS (
    SELECT 1 FROM "Purchase" p WHERE p."vendorId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "FactKey" f WHERE f."factKind" = 'index:Purchase'
        AND f."factId" = p.id::text AND f.key = 'index:purchase.vendor:' || p."vendorId"::text)
  ) THEN
    RAISE EXCEPTION 'Purchase memberships: a Purchase is missing its stored key';
  END IF;

  CREATE TEMP TABLE email_state_dep_scopes ON COMMIT DROP AS
    SELECT DISTINCT "scopeKey" FROM "ScopeDep" WHERE "scopeKind" = 'emailState';
  SELECT count(*) INTO dep_scopes FROM email_state_dep_scopes;
  SELECT count(*) INTO dep_rows FROM "ScopeDep" WHERE "scopeKind" = 'emailState';
  SELECT count(*) INTO dirty_before FROM "ScopeDirty" WHERE "scopeKind" = 'emailState';

  INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason)
  SELECT 'emailState', "scopeKey", 'money', 'email state dependency keys'
  FROM email_state_dep_scopes
  ORDER BY "scopeKey"
  ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
    seq = "ScopeDirty".seq + 1,
    reason = excluded.reason,
    attempts = 0,
    "availableAt" = LEAST("ScopeDirty"."availableAt", now()),
    "waitCause" = NULL,
    "updatedAt" = now();
  DELETE FROM "ScopeDep" WHERE "scopeKind" = 'emailState';

  IF EXISTS (SELECT 1 FROM "ScopeDep" WHERE "scopeKind" = 'emailState') THEN
    RAISE EXCEPTION 'emailState dependencies: rows remain after the delete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM email_state_dep_scopes s WHERE NOT EXISTS (
      SELECT 1 FROM "ScopeDirty" d
      WHERE d."scopeKind" = 'emailState' AND d."scopeKey" = s."scopeKey"
        AND d.attempts = 0 AND d."waitCause" IS NULL AND d."availableAt" <= now())
  ) THEN
    RAISE EXCEPTION 'emailState dependencies: a scope lost its edges without being claimable';
  END IF;
  SELECT count(*) INTO dirty_after FROM "ScopeDirty" WHERE "scopeKind" = 'emailState';
  RAISE NOTICE 'Purchase memberships: % order, % vendor; emailState: % ScopeDep rows of % scopes deleted, dirty % -> %',
    order_rows, vendor_rows, dep_rows, dep_scopes, dirty_before, dirty_after;
END $$;
--> statement-breakpoint

-- The deleted and superseded dependency rows are returned by copying the live
-- rows; no foreign key or trigger references ScopeDep.
DO $$
DECLARE
  dep_before bigint;
  dep_after bigint;
BEGIN
  SELECT count(*) INTO dep_before FROM "ScopeDep";
  CREATE TEMP TABLE scope_dep_live ON COMMIT DROP AS
    SELECT "scopeKind", "scopeKey", key FROM "ScopeDep";
  TRUNCATE "ScopeDep";
  INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
  SELECT "scopeKind", "scopeKey", key FROM scope_dep_live
  ORDER BY "scopeKind", "scopeKey", key;
  SELECT count(*) INTO dep_after FROM "ScopeDep";
  IF dep_after <> dep_before OR EXISTS (
    SELECT 1 FROM scope_dep_live l WHERE NOT EXISTS (
      SELECT 1 FROM "ScopeDep" d WHERE d."scopeKind" = l."scopeKind"
        AND d."scopeKey" = l."scopeKey" AND d.key = l.key)
  ) THEN
    RAISE EXCEPTION 'ScopeDep rewrite: % rows before, % after', dep_before, dep_after;
  END IF;
END $$;
--> statement-breakpoint
ANALYZE "ScopeDep";
--> statement-breakpoint
ANALYZE "FactKey";
