-- Apply with purchase/mail writers and deliveries quiesced. These active Runs
-- predate the replacement contract; preserve their evidence and decisions, but
-- release admission for fresh, explicitly converted successor work.
UPDATE "Run"
SET "status" = 'needs_review',
    "endedAt" = COALESCE("endedAt", now()),
    "dispatchError" = concat_ws(E'\n',
      "dispatchError",
      CASE WHEN "failureCode" IS NOT NULL THEN 'Previous failure code: ' || "failureCode" END,
      'Interrupted legacy research requires a fresh admitted replacement Run.'),
    "failureCode" = 'research_rewrite_required'
WHERE "deletedAt" IS NULL AND "retiredAt" IS NULL
  AND "purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'mail_search', 'mail_discovery')
  AND "status" IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');
