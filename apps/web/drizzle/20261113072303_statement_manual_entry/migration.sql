CREATE TABLE "ManualEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entity" text NOT NULL,
	"userId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "ManualEntry" (id, entity, "userId", payload)
SELECT t.id, 'financialTransaction', coalesce(p."userId", 'legacy:household'),
  jsonb_build_object('accountId', a.shortcode, 'kind', t.kind, 'status', t.status,
    'amount', t."amountMinor"::numeric / 100, 'transactionDate', t."transactionDate", 'postedDate', t."postedDate",
    'merchant', t.merchant, 'rawDescription', t."rawDescription", 'sourceCategory', t."sourceCategory", 'notes', t.notes,
    'itemizationExpectation', t."itemizationExpectation", 'sourceRefs', '[]'::jsonb, 'allocations', '[]'::jsonb)
FROM "FinancialTransaction" t JOIN "FinancialAccount" a ON a.id = t."accountId"
LEFT JOIN "LedgerParty" p ON p.id = a."ledgerPartyId"
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "RecordKey" ("scopeKind", "scopeKey", entity, "naturalKey", "entityId", "rejectedAt")
SELECT 'bankEvent', coalesce((SELECT min(o.id::text) FROM "SourceOccurrence" o WHERE o."acceptedTransactionId" = t.id), 'manual:' || t.id::text),
  'financialTransaction', 'legacy:' || t.id::text, t.id, t."deletedAt"
FROM "FinancialTransaction" t;
--> statement-breakpoint
INSERT INTO "EvidenceBinding" ("factKind", "factId", "eventKey", basis, "scopeKind", "scopeKey")
SELECT 'manualEntry', k."entityId"::text, k."entityId"::text, 'baseline', k."scopeKind", k."scopeKey"
FROM "RecordKey" k WHERE k."scopeKind" = 'bankEvent' AND k.entity = 'financialTransaction';
--> statement-breakpoint
INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage)
SELECT DISTINCT "scopeKind", "scopeKey", 0, '', 'done' FROM "RecordKey" WHERE "scopeKind" = 'bankEvent';
--> statement-breakpoint
INSERT INTO "FactKey" (key, "factKind", "factId")
SELECT 'manual:' || id::text, 'manualEntry', id::text FROM "ManualEntry"
UNION ALL SELECT 'occurrence:' || id::text, 'sourceOccurrence', id::text FROM "SourceOccurrence"
UNION ALL SELECT 'row:SourceOccurrence:' || id::text, 'sourceOccurrence', id::text FROM "SourceOccurrence"
UNION ALL SELECT 'occurrence:' || "occurrenceId"::text, 'statementObservation', id::text FROM "SourceTransactionRecord"
UNION ALL SELECT 'row:SourceTransactionRecord:' || id::text, 'statementObservation', id::text FROM "SourceTransactionRecord"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "FinancialTransaction" t LEFT JOIN "RecordKey" k ON k.entity = 'financialTransaction' AND k."entityId" = t.id AND k."naturalKey" = 'legacy:' || t.id::text LEFT JOIN "ManualEntry" m ON m.id = t.id
    WHERE k."entityId" IS NULL OR (m.payload->>'amount')::numeric * 100 IS DISTINCT FROM t."amountMinor"::numeric) THEN
    RAISE EXCEPTION 'Bank-event baseline did not preserve every transaction identity and exact amount';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.cubby_kernel_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || pg_temp.cubby_kernel_canonical(val), ',' ORDER BY key COLLATE "C"), '') || '}' INTO result FROM jsonb_each(value) AS item(key, val);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(pg_temp.cubby_kernel_canonical(val), ',' ORDER BY ord), '') || ']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS item(val, ord);
    WHEN 'number' THEN
      result := value::text;
      IF position('.' IN result) > 0 THEN result := rtrim(rtrim(result, '0'), '.'); END IF;
    ELSE result := value::text;
  END CASE;
  RETURN result;
END $$;
--> statement-breakpoint
WITH retained AS (
  SELECT s.id, s."createdAt", s.data->'answers'->'kind' AS answer
  FROM "Suggestion" s WHERE s.family = 'statement_transaction'
    AND jsonb_typeof(s.data->'answers'->'kind'->'input') = 'object'
    AND s.data->'answers'->'kind'->'versions'->>'statement-transaction-kind' = '2026-11-12.1'
), envelopes AS (
  SELECT *, jsonb_build_object('feature', 'statement-transaction-kind', 'producer', 'model', 'tier', NULL, 'model', NULL,
    'outputRevision', 'financial-transaction-kind.v1', 'parameters', NULL, 'promptVersion', '2026-11-12.1', 'input', answer->'input') AS envelope FROM retained
), hashed AS (
  SELECT *, encode(sha256(convert_to(pg_temp.cubby_kernel_canonical(envelope), 'UTF8')), 'hex') AS hash FROM envelopes
)
INSERT INTO "Answer" ("inputHash", feature, producer, "promptVersion", output, model, raw, "createdAt")
SELECT DISTINCT ON (hash) hash, 'statement-transaction-kind', 'model', '2026-11-12.1', answer->'value', answer->'models'->>0, answer::text, "createdAt"
FROM hashed ORDER BY hash, "createdAt" DESC, id DESC
ON CONFLICT ("inputHash") DO NOTHING;
--> statement-breakpoint
INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage)
SELECT 'bankEvent', id::text, 0, '', 'done' FROM "SourceOccurrence"
ON CONFLICT ("scopeKind", "scopeKey") DO NOTHING;

--> statement-breakpoint
CREATE TEMP TABLE cubby_purchase_event_seed AS
SELECT 'purchase'::text AS entity, 'Purchase'::text AS table_name, p.id,
  coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId" = p.id AND a."deletedAt" IS NULL), p.id::text) AS scope_key,
  (to_jsonb(p) - ARRAY['id','shortcode','createdAt','updatedAt','deletedAt','statedTotalMinor']) || jsonb_build_object('statedTotal', p."statedTotalMinor"::text) AS payload,
  p."deletedAt" AS rejected_at
FROM "Purchase" p
UNION ALL
SELECT 'expense', 'Expense', e.id,
  coalesce((SELECT coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId" = p.id AND a."deletedAt" IS NULL), p.id::text) FROM "Purchase" p WHERE p.id = e."purchaseId"), e.id::text),
  (to_jsonb(e) - ARRAY['id','shortcode','createdAt','updatedAt','deletedAt','costMinor']) || jsonb_build_object('cost', e."costMinor"::text), e."deletedAt"
FROM "Expense" e
UNION ALL
SELECT 'FinancialTransactionAllocation', 'FinancialTransactionAllocation', a.id, a."transactionId"::text,
  (to_jsonb(a) - ARRAY['id','createdAt','updatedAt','deletedAt']) || jsonb_build_object('amountMinor', a."amountMinor"::text), a."deletedAt"
FROM "FinancialTransactionAllocation" a
UNION ALL
SELECT 'ExpenseAttribution', 'ExpenseAttribution', a.id,
  coalesce((SELECT coalesce((SELECT min(s."transactionId"::text) FROM "FinancialTransactionAllocation" s WHERE s."purchaseId" = e."purchaseId" AND s."deletedAt" IS NULL), e."purchaseId"::text, e.id::text) FROM "Expense" e WHERE e.id = a."expenseId"), a.id::text),
  to_jsonb(a) - ARRAY['id','createdAt','updatedAt','deletedAt'], a."deletedAt"
FROM "ExpenseAttribution" a;
--> statement-breakpoint
INSERT INTO "ManualEntry" (id, entity, "userId", payload)
SELECT md5('manualEntry:' || table_name || ':' || id)::uuid, entity, 'legacy:household',
  jsonb_build_object('purchaseEvent', scope_key, 'table', table_name, 'naturalKey', 'legacy:' || id, 'values', payload)
FROM cubby_purchase_event_seed
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "RecordKey" ("scopeKind", "scopeKey", entity, "naturalKey", "entityId", "rejectedAt")
SELECT 'purchaseEvent', scope_key, entity, 'legacy:' || id, id, rejected_at
FROM cubby_purchase_event_seed;
--> statement-breakpoint
INSERT INTO "EvidenceBinding" ("factKind", "factId", "eventKey", basis, "scopeKind", "scopeKey")
SELECT 'manualEntry', md5('manualEntry:' || table_name || ':' || id)::uuid, id::text, 'baseline', 'purchaseEvent', scope_key
FROM cubby_purchase_event_seed;
--> statement-breakpoint
INSERT INTO "FactKey" ("factKind", "factId", key)
SELECT 'manualEntry', md5('manualEntry:' || table_name || ':' || id)::uuid, 'purchaseEvent:' || scope_key FROM cubby_purchase_event_seed
UNION ALL
SELECT 'manualEntry', md5('manualEntry:' || table_name || ':' || id)::uuid, 'manual:' || md5('manualEntry:' || table_name || ':' || id)::uuid FROM cubby_purchase_event_seed;
--> statement-breakpoint
INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage)
SELECT DISTINCT 'purchaseEvent', scope_key, 0, '', 'done' FROM cubby_purchase_event_seed
ON CONFLICT ("scopeKind", "scopeKey") DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cubby_purchase_event_seed s LEFT JOIN "RecordKey" k ON k.entity = s.entity AND k."entityId" = s.id AND k."scopeKind" = 'purchaseEvent' AND k."scopeKey" = s.scope_key AND k."naturalKey" = 'legacy:' || s.id WHERE k."entityId" IS NULL) THEN
    RAISE EXCEPTION 'Purchase event identity preservation failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cubby_purchase_event_seed s JOIN "Expense" e ON s.entity = 'expense' AND s.id = e.id
    WHERE (s.payload->>'cost')::bigint IS DISTINCT FROM e."costMinor"
  ) OR EXISTS (
    SELECT 1 FROM cubby_purchase_event_seed s JOIN "Purchase" p ON s.entity = 'purchase' AND s.id = p.id
    WHERE (s.payload->>'statedTotal')::bigint IS DISTINCT FROM p."statedTotalMinor"
  ) OR EXISTS (
    SELECT 1 FROM cubby_purchase_event_seed s JOIN "FinancialTransactionAllocation" a ON s.entity = 'FinancialTransactionAllocation' AND s.id = a.id
    WHERE (s.payload->>'amountMinor')::bigint IS DISTINCT FROM a."amountMinor"
  ) THEN RAISE EXCEPTION 'Purchase event exact money preservation failed'; END IF;

END $$;

--> statement-breakpoint
DROP TABLE cubby_purchase_event_seed;

--> statement-breakpoint
WITH retained AS (
  SELECT s."updatedAt", a.*
  FROM "Suggestion" s CROSS JOIN LATERAL (VALUES
    ('merchant-identity', '2026-11-13.1', 'merchant-identity.v1', s.data->'answers'->'merchant'->'identity'),
    ('merchant-identity-support', '2026-11-13.1', 'merchant-identity-support.v1', s.data->'answers'->'merchant'->'support'),
    ('loan-escrow-disbursement', '2026-11-12.1', 'loan-escrow-disbursement.v1', s.data->'answers'->'escrow')
  ) a(feature, version, revision, answer)
  WHERE s.family = 'statement_transaction' AND jsonb_typeof(a.answer->'input') = 'object'
    AND a.answer->'versions'->>a.feature = a.version
), envelopes AS (
  SELECT *, jsonb_build_object('feature', feature, 'producer', 'model', 'tier', NULL, 'model', NULL,
    'outputRevision', revision, 'parameters', NULL, 'promptVersion', version, 'input', answer->'input') AS envelope
  FROM retained
), hashed AS (
  SELECT *, encode(sha256(convert_to(pg_temp.cubby_kernel_canonical(envelope), 'UTF8')), 'hex') AS hash FROM envelopes
)
INSERT INTO "Answer" ("inputHash", feature, producer, "promptVersion", output, model, raw, "createdAt")
SELECT DISTINCT ON (hash) hash, feature, 'model', version, answer->'value', answer->'models'->>0, answer::text, "updatedAt"
FROM hashed ORDER BY hash, "updatedAt" DESC
ON CONFLICT ("inputHash") DO NOTHING;

--> statement-breakpoint
WITH raw_values AS (
  SELECT 'financialTransaction'::text AS entity, t.id,
    (to_jsonb(t) - ARRAY['id','shortcode','createdAt','updatedAt','deletedAt','amountMinor','ledgerTransferId','bookingDecisionFingerprint','bookingExpenseFingerprint','bookingCorrectionReceipt'])
      || jsonb_build_object('amount', t."amountMinor"::text) AS values
  FROM "FinancialTransaction" t
  UNION ALL
  SELECT m.entity, k."entityId", m.payload->'values'
  FROM "ManualEntry" m JOIN "RecordKey" k ON k."scopeKind" = 'purchaseEvent' AND k.entity = m.entity
    AND k."naturalKey" = m.payload->>'naturalKey' AND k."scopeKey" = m.payload->>'purchaseEvent'
  WHERE m.entity IN ('purchase', 'expense')
), fields AS (
  SELECT r.entity, r.id, f.key AS field, f.value, a.*
  FROM raw_values r CROSS JOIN LATERAL jsonb_each(r.values) f
  JOIN LATERAL (
    SELECT a.id AS audit_id, a."userId", a.channel, a."oauthClientId", a."runId", a.authority, a."createdAt", a.changes
    FROM "AuditLog" a WHERE a."entityKind" = r.entity AND a."entityId" = r.id
      AND (a.action = 'create' OR a.changes ? f.key)
    ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
  ) a ON true
  WHERE a.authority IS NULL AND a.channel <> 'system' AND a."runId" IS NULL AND a."userId" <> 'cubby-system'
    AND (f.value <> 'null'::jsonb OR a.changes ? f.key)
)
INSERT INTO "Decision" (id, channel, subject, slot, field, kind, value, "actorKind", "actorId", at)
SELECT md5('money-held:' || entity || ':' || id || ':' || field || ':' || audit_id)::uuid,
  'assignment', entity || ':' || id, field, field, CASE WHEN value = 'null'::jsonb THEN 'none' ELSE 'set' END, value,
  CASE WHEN "oauthClientId" IS NULL THEN 'member' ELSE 'agent' END, "userId", "createdAt"
FROM fields ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "ScopeState" ("scopeKind", "scopeKey", version, rules, stage)
SELECT 'purchaseEvent', id::text, 0, '', 'done' FROM "FinancialTransaction"
ON CONFLICT ("scopeKind", "scopeKey") DO NOTHING;
