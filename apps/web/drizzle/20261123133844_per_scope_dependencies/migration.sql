-- Plain reads are invisible to the runner's lock detection. Every table this
-- migration reads or writes is named here.
LOCK TABLE "ScopeDep", "ScopeDirty", "FactKey", "FinancialTransaction", "Expense", "Vendor" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Per-scope dependency keys for payment matching, transfer pairing and
-- Shipments.
--
-- 1. Four read indexes are added over values an authored write can change,
--    whose before image is the stored `index:<table>` FactKey membership, so
--    every row gets its rows here, spelled exactly as the declarations'
--    `values`:
--      index:transaction.amount:<signed amount>      every FinancialTransaction
--      index:transaction.transfer:<ledgerTransferId> FinancialTransaction with a transfer
--      index:expense.bookingTransaction:<code>       Expense with a non-empty booking code
--      index:vendor.merchant:<merchant key>          each Vendor name and alias:
--        the six ASCII whitespace characters (space, tab, line feed, vertical
--        tab, form feed, carriage return) trimmed and each run collapsed to one
--        space, A-Z lower-cased, exactly as `merchantKey`; an empty key is not
--        stored
--    The ManualEntry and Decision allocation indexes cover insert-only rows,
--    so no write moves a row between their memberships and they store nothing.
--
-- 2. purchaseEvent payment scopes (scope keys starting `payment:`) and
--    transferPair scopes registered batch-wide keys and declared column keys.
--    Shipment scopes read the whole Shipment table. Each such scope holding
--    ScopeDep rows is made dirty the way markDirty dirties a scope on a new
--    input and all of its ScopeDep rows are deleted; its next publication
--    registers its own keys, and an in-flight load is still refused by the
--    KeyRev fence on every key it read. purchaseEvent bank and order scopes
--    keep their rows.
DO $$
DECLARE
  ft_total bigint;
  ft_linked bigint;
  expense_booked bigint;
  vendor_keys bigint;
  amount_rows bigint;
  transfer_rows bigint;
  booking_rows bigint;
  merchant_rows bigint;
  dep_rows bigint;
  dep_scopes bigint;
  dirty_before bigint;
  dirty_after bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE "ledgerTransferId" IS NOT NULL)
    INTO ft_total, ft_linked FROM "FinancialTransaction";
  SELECT count(*) INTO expense_booked FROM "Expense"
    WHERE "bookingTransactionCode" <> '';

  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT 'index:transaction.amount:' || "amountMinor"::text,
    'index:FinancialTransaction', id::text
  FROM "FinancialTransaction"
  ON CONFLICT DO NOTHING;
  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT 'index:transaction.transfer:' || "ledgerTransferId"::text,
    'index:FinancialTransaction', id::text
  FROM "FinancialTransaction" WHERE "ledgerTransferId" IS NOT NULL
  ON CONFLICT DO NOTHING;
  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT 'index:expense.bookingTransaction:' || "bookingTransactionCode",
    'index:Expense', id::text
  FROM "Expense" WHERE "bookingTransactionCode" <> ''
  ON CONFLICT DO NOTHING;
  INSERT INTO "FactKey" (key, "factKind", "factId")
  SELECT DISTINCT 'index:vendor.merchant:' || merchant.key, 'index:Vendor', v.id::text
  FROM "Vendor" v
  CROSS JOIN LATERAL unnest(array_prepend(v.name, v.aliases)) alias(name)
  CROSS JOIN LATERAL (SELECT translate(regexp_replace(regexp_replace(alias.name,
    '^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$', '', 'g'), '[ \t\n\v\f\r]+', ' ', 'g'),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS key) merchant
  WHERE merchant.key <> ''
  ON CONFLICT DO NOTHING;

  SELECT count(DISTINCT (v.id, merchant.key)) INTO vendor_keys
  FROM "Vendor" v
  CROSS JOIN LATERAL unnest(array_prepend(v.name, v.aliases)) alias(name)
  CROSS JOIN LATERAL (SELECT translate(regexp_replace(regexp_replace(alias.name,
    '^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$', '', 'g'), '[ \t\n\v\f\r]+', ' ', 'g'),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS key) merchant
  WHERE merchant.key <> '';
  SELECT count(*) INTO amount_rows FROM "FactKey"
    WHERE "factKind" = 'index:FinancialTransaction' AND key LIKE 'index:transaction.amount:%';
  SELECT count(*) INTO transfer_rows FROM "FactKey"
    WHERE "factKind" = 'index:FinancialTransaction' AND key LIKE 'index:transaction.transfer:%';
  SELECT count(*) INTO booking_rows FROM "FactKey"
    WHERE "factKind" = 'index:Expense' AND key LIKE 'index:expense.bookingTransaction:%';
  SELECT count(*) INTO merchant_rows FROM "FactKey"
    WHERE "factKind" = 'index:Vendor' AND key LIKE 'index:vendor.merchant:%';
  IF amount_rows <> ft_total OR transfer_rows <> ft_linked
    OR booking_rows <> expense_booked OR merchant_rows <> vendor_keys THEN
    RAISE EXCEPTION 'Read-index memberships: % amount for % transactions, % transfer for % linked, % booking for % Expenses, % merchant for % Vendor keys',
      amount_rows, ft_total, transfer_rows, ft_linked, booking_rows, expense_booked,
      merchant_rows, vendor_keys;
  END IF;

  CREATE TEMP TABLE scope_dep_per_scope ON COMMIT DROP AS
    SELECT DISTINCT d."scopeKind", d."scopeKey", lanes.lane
    FROM "ScopeDep" d
    JOIN (VALUES ('purchaseEvent', 'money'), ('transferPair', 'money'),
      ('shipment', 'money')) AS lanes(kind, lane) ON lanes.kind = d."scopeKind"
    WHERE (d."scopeKind" = 'purchaseEvent' AND d."scopeKey" LIKE 'payment:%')
      OR d."scopeKind" IN ('transferPair', 'shipment');
  SELECT count(*) INTO dep_scopes FROM scope_dep_per_scope;
  SELECT count(*) INTO dep_rows FROM "ScopeDep" d
    WHERE EXISTS (SELECT 1 FROM scope_dep_per_scope s
      WHERE s."scopeKind" = d."scopeKind" AND s."scopeKey" = d."scopeKey");
  SELECT count(*) INTO dirty_before FROM "ScopeDirty"
    WHERE "scopeKind" IN ('purchaseEvent', 'transferPair', 'shipment');

  INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason)
  SELECT "scopeKind", "scopeKey", lane, 'per-scope dependency keys'
  FROM scope_dep_per_scope
  ORDER BY "scopeKind", "scopeKey"
  ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
    seq = "ScopeDirty".seq + 1,
    reason = excluded.reason,
    attempts = 0,
    "availableAt" = LEAST("ScopeDirty"."availableAt", now()),
    "waitCause" = NULL,
    "updatedAt" = now();
  DELETE FROM "ScopeDep" d USING scope_dep_per_scope s
    WHERE s."scopeKind" = d."scopeKind" AND s."scopeKey" = d."scopeKey";

  IF EXISTS (SELECT 1 FROM "ScopeDep"
    WHERE ("scopeKind" = 'purchaseEvent' AND "scopeKey" LIKE 'payment:%')
      OR "scopeKind" IN ('transferPair', 'shipment')) THEN
    RAISE EXCEPTION 'Per-scope dependencies: rows of a changed kind remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM scope_dep_per_scope s WHERE NOT EXISTS (
      SELECT 1 FROM "ScopeDirty" d
      WHERE d."scopeKind" = s."scopeKind" AND d."scopeKey" = s."scopeKey"
        AND d.attempts = 0 AND d."waitCause" IS NULL AND d."availableAt" <= now())
  ) THEN
    RAISE EXCEPTION 'Per-scope dependencies: a scope lost its edges without being claimable';
  END IF;
  SELECT count(*) INTO dirty_after FROM "ScopeDirty"
    WHERE "scopeKind" IN ('purchaseEvent', 'transferPair', 'shipment');
  RAISE NOTICE 'Memberships: % amount, % transfer, % booking, % merchant; % ScopeDep rows of % scopes deleted, dirty % -> %',
    amount_rows, transfer_rows, booking_rows, merchant_rows, dep_rows, dep_scopes,
    dirty_before, dirty_after;
END $$;
--> statement-breakpoint

-- The deleted dependency rows are returned by copying the live rows; no
-- foreign key or trigger references ScopeDep.
DO $$
DECLARE
  dep_before bigint;
  dep_after bigint;
BEGIN
  SELECT count(*) INTO dep_before FROM "ScopeDep";
  CREATE TEMP TABLE scope_dep_per_scope_live ON COMMIT DROP AS
    SELECT "scopeKind", "scopeKey", key FROM "ScopeDep";
  TRUNCATE "ScopeDep";
  INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
  SELECT "scopeKind", "scopeKey", key FROM scope_dep_per_scope_live
  ORDER BY "scopeKind", "scopeKey", key;
  SELECT count(*) INTO dep_after FROM "ScopeDep";
  IF dep_after <> dep_before OR EXISTS (
    SELECT 1 FROM scope_dep_per_scope_live l WHERE NOT EXISTS (
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
