-- Copies, plain reads and CLUSTER are invisible to the runner's lock
-- detection. Every table this block reads or writes is named here.
LOCK TABLE "ScopeDep", "KeyRev", "FactKey", "Run", "FinancialTransaction", "SourceOccurrence", "FinancialTransactionAllocation", "Expense", "ExpenseAttribution", "Purchase", "PurchasePaymentEvidence", "Vendor", "ManualEntry" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Bank-event dependency keys. Two read-index families are retired:
--   index:transaction.accountAmount:<account uuid>:<signed amount>:<ISO date>
--   index:manualTransaction.accountMerchant:<account uuid or shortcode>:<merchant>
-- Every retained dependency edge is projected into the replacement family,
-- deduplicated per scope:
--   index:transaction.amountDay:<absolute amount>:<ISO date>
--   index:manualTransaction.merchant:<merchant>
-- An account id holds no colon; a merchant may, so it is everything after the
-- account's separator. Every other row is copied verbatim. Neither table is
-- referenced by a foreign key or carries a trigger, so TRUNCATE returns the
-- storage inside this transaction. Replacement keys need no KeyRev row: an
-- absent revision reads 0.
-- Production read-only counts: ScopeDep 21,144,535 rows, 14,777,356 retired
-- (12,933,424 amount, 1,843,932 merchant), 6,367,179 kept, about 200,000
-- projected. KeyRev 12,987,168 rows, 12,062,296 retired, 924,872 kept.
DO $$
DECLARE
  amount_prefix constant text := 'index:transaction.accountAmount:';
  merchant_prefix constant text := 'index:manualTransaction.accountMerchant:';
  dep_total bigint;
  dep_retired bigint;
  dep_unparsed bigint;
  dep_projected bigint;
  dep_after bigint;
  rev_total bigint;
  rev_retired bigint;
  rev_after bigint;
BEGIN
  SELECT count(*) INTO dep_total FROM "ScopeDep";
  SELECT count(*),
    count(*) FILTER (WHERE
      (key LIKE amount_prefix || '%'
        AND key !~ '^index:transaction\.accountAmount:[^:]+:-?[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      OR (key LIKE merchant_prefix || '%'
        AND strpos(substr(key, length(merchant_prefix) + 1), ':') = 0))
    INTO dep_retired, dep_unparsed
  FROM "ScopeDep"
  WHERE key LIKE amount_prefix || '%' OR key LIKE merchant_prefix || '%';
  IF dep_unparsed <> 0 THEN
    RAISE EXCEPTION 'ScopeDep rebuild: % retired keys do not parse', dep_unparsed;
  END IF;

  CREATE TEMP TABLE scope_dep_next ON COMMIT DROP AS
    SELECT "scopeKind", "scopeKey", key, false AS projected
    FROM "ScopeDep"
    WHERE key NOT LIKE amount_prefix || '%' AND key NOT LIKE merchant_prefix || '%'
    UNION ALL
    SELECT DISTINCT "scopeKind", "scopeKey",
      CASE WHEN key LIKE amount_prefix || '%' THEN
        'index:transaction.amountDay:'
          || ltrim(split_part(substr(key, length(amount_prefix) + 1), ':', 2), '-')
          || ':' || split_part(substr(key, length(amount_prefix) + 1), ':', 3)
      ELSE
        'index:manualTransaction.merchant:'
          || substr(
            substr(key, length(merchant_prefix) + 1),
            strpos(substr(key, length(merchant_prefix) + 1), ':') + 1)
      END,
      true
    FROM "ScopeDep"
    WHERE key LIKE amount_prefix || '%' OR key LIKE merchant_prefix || '%';
  SELECT count(*) INTO dep_projected FROM scope_dep_next WHERE projected;

  TRUNCATE "ScopeDep";
  INSERT INTO "ScopeDep" ("scopeKind", "scopeKey", key)
  SELECT "scopeKind", "scopeKey", key FROM scope_dep_next
  ORDER BY "scopeKind", "scopeKey", key;

  SELECT count(*) INTO dep_after FROM "ScopeDep";
  IF dep_after - dep_projected <> dep_total - dep_retired THEN
    RAISE EXCEPTION 'ScopeDep rebuild: kept % rows, expected %',
      dep_after - dep_projected, dep_total - dep_retired;
  END IF;
  IF EXISTS (SELECT 1 FROM "ScopeDep"
    WHERE key LIKE amount_prefix || '%' OR key LIKE merchant_prefix || '%') THEN
    RAISE EXCEPTION 'ScopeDep rebuild: a retired key remains';
  END IF;
  IF (SELECT count(*) FROM "ScopeDep"
      WHERE key LIKE 'index:transaction.amountDay:%'
        OR key LIKE 'index:manualTransaction.merchant:%') <> dep_projected THEN
    RAISE EXCEPTION 'ScopeDep rebuild: projected rows do not match';
  END IF;

  SELECT count(*),
    count(*) FILTER (WHERE key LIKE amount_prefix || '%' OR key LIKE merchant_prefix || '%')
    INTO rev_total, rev_retired
  FROM "KeyRev";
  CREATE TEMP TABLE key_rev_keep ON COMMIT DROP AS
    SELECT key, rev FROM "KeyRev"
    WHERE key NOT LIKE amount_prefix || '%' AND key NOT LIKE merchant_prefix || '%';
  TRUNCATE "KeyRev";
  INSERT INTO "KeyRev" (key, rev) SELECT key, rev FROM key_rev_keep ORDER BY key;
  SELECT count(*) INTO rev_after FROM "KeyRev";
  IF rev_after <> rev_total - rev_retired THEN
    RAISE EXCEPTION 'KeyRev rebuild: kept % rows, expected %',
      rev_after, rev_total - rev_retired;
  END IF;
  IF EXISTS (SELECT 1 FROM "KeyRev"
    WHERE key LIKE amount_prefix || '%' OR key LIKE merchant_prefix || '%') THEN
    RAISE EXCEPTION 'KeyRev rebuild: a retired key remains';
  END IF;
  IF EXISTS (SELECT 1 FROM key_rev_keep k
    WHERE NOT EXISTS (SELECT 1 FROM "KeyRev" r WHERE r.key = k.key AND r.rev = k.rev)) THEN
    RAISE EXCEPTION 'KeyRev rebuild: a kept revision changed';
  END IF;
END $$;
--> statement-breakpoint
ANALYZE "ScopeDep";
--> statement-breakpoint
ANALYZE "KeyRev";
--> statement-breakpoint

-- Stored read-index membership (`index:<table>` FactKey rows) is the row an
-- authored writer changed. Rebuild it from the current rows of every indexed
-- table, in each index's `values` spelling, so no row is missing its stored
-- keys and none holds a retired spelling.
DELETE FROM "FactKey" WHERE "factKind" IN (
  'index:FinancialTransaction', 'index:SourceOccurrence',
  'index:FinancialTransactionAllocation', 'index:Expense',
  'index:ExpenseAttribution', 'index:Purchase',
  'index:PurchasePaymentEvidence', 'index:Vendor', 'index:ManualEntry');
--> statement-breakpoint
INSERT INTO "FactKey" (key, "factKind", "factId")
SELECT DISTINCT key, kind, id FROM (
  SELECT 'index:FinancialTransaction' AS kind, id::text AS id,
    'index:transaction.amountDay:' || abs("amountMinor")::text || ':'
      || to_char(coalesce("transactionDate", "postedDate"), 'YYYY-MM-DD') AS key
  FROM "FinancialTransaction"
  WHERE coalesce("transactionDate", "postedDate") IS NOT NULL
  UNION ALL
  SELECT 'index:SourceOccurrence', id::text,
    'index:occurrence.transaction:' || "acceptedTransactionId"
  FROM "SourceOccurrence" WHERE "acceptedTransactionId" IS NOT NULL
  UNION ALL
  SELECT 'index:FinancialTransactionAllocation', id::text,
    'index:allocation.transaction:' || "transactionId"
  FROM "FinancialTransactionAllocation"
  UNION ALL
  SELECT 'index:FinancialTransactionAllocation', id::text,
    'index:allocation.purchase:' || "purchaseId"
  FROM "FinancialTransactionAllocation"
  UNION ALL
  SELECT 'index:Expense', id::text, 'index:expense.purchase:' || "purchaseId"
  FROM "Expense" WHERE "purchaseId" IS NOT NULL
  UNION ALL
  SELECT 'index:Expense', id::text, 'index:expense.unlinkedProduct:' || "productId"
  FROM "Expense"
  WHERE "deletedAt" IS NULL AND "purchaseId" IS NULL AND "productId" IS NOT NULL
  UNION ALL
  SELECT 'index:ExpenseAttribution', id::text,
    'index:attribution.expense:' || "expenseId"
  FROM "ExpenseAttribution"
  UNION ALL
  SELECT 'index:Purchase', id::text,
    'index:purchase.vendorDate:' || "vendorId" || ':' || to_char(date, 'YYYY-MM-DD')
  FROM "Purchase" WHERE "vendorId" IS NOT NULL AND date IS NOT NULL
  UNION ALL
  SELECT 'index:PurchasePaymentEvidence', id::text,
    'index:payment.amount:' || "amountMinor"::text
  FROM "PurchasePaymentEvidence"
  UNION ALL
  SELECT 'index:PurchasePaymentEvidence', id::text,
    'index:payment.purchase:' || "purchaseId"
  FROM "PurchasePaymentEvidence" WHERE "purchaseId" IS NOT NULL
  UNION ALL
  SELECT 'index:PurchasePaymentEvidence', id::text,
    'index:payment.orderObservation:' || "orderObservationId"
  FROM "PurchasePaymentEvidence" WHERE "orderObservationId" IS NOT NULL
  UNION ALL
  SELECT 'index:Vendor', v.id::text,
    'index:vendor.name:' || lower(regexp_replace(name.value, '^\s+|\s+$', '', 'g'))
  FROM "Vendor" v
  CROSS JOIN LATERAL unnest(ARRAY[v.name] || v.aliases) AS name(value)
  UNION ALL
  SELECT 'index:ManualEntry', id::text,
    'index:manualTransaction.merchant:' || lower(trim(payload->>'merchant'))
  FROM "ManualEntry"
  WHERE entity = 'financialTransaction'
    AND jsonb_typeof(payload) = 'object'
    AND jsonb_typeof(payload->'merchant') = 'string'
) AS membership
WHERE key IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- `Run.input` was trimmed in place; the rewrite returns its storage.
CLUSTER "Run" USING "Run_pkey";
--> statement-breakpoint
ALTER TABLE "Run" SET WITHOUT CLUSTER;
--> statement-breakpoint
ANALYZE "Run";
--> statement-breakpoint

-- The retired key families are gone; the previous Worker's writes of them now fail.
DROP INDEX "ManualEntry_financial_history_lookup_idx";--> statement-breakpoint
CREATE INDEX "FinancialTransaction_amount_day_idx" ON "FinancialTransaction" ((abs("amountMinor")::text || ':' || (coalesce("transactionDate", "postedDate") - DATE '1970-01-01')::text));--> statement-breakpoint
CREATE INDEX "ManualEntry_financial_merchant_idx" ON "ManualEntry" ((md5(lower(trim("payload"->>'merchant')))));--> statement-breakpoint
ALTER TABLE "KeyRev" ADD CONSTRAINT "KeyRev_retired_key_check" CHECK ("key" NOT LIKE 'index:transaction.accountAmount:%' AND "key" NOT LIKE 'index:manualTransaction.accountMerchant:%');--> statement-breakpoint
ALTER TABLE "ScopeDep" ADD CONSTRAINT "ScopeDep_retired_key_check" CHECK ("key" NOT LIKE 'index:transaction.accountAmount:%' AND "key" NOT LIKE 'index:manualTransaction.accountMerchant:%');
