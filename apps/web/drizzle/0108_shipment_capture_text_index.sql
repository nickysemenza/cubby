-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ShipmentSourceCapture_text_gin_idx" ON "ShipmentSourceCapture" USING gin ((upper(regexp_replace(coalesce("originalContent"->>'bodyText', '') || ' ' || coalesce("originalContent"->>'bodyHtml', '') || ' ' || coalesce("source"->>'content', '') || ' ' || coalesce("source"->>'url', ''), '[[:space:]]', '', 'g'))) gin_trgm_ops);
