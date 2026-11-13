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
