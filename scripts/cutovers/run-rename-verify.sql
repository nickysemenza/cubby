-- Every row must report zero after scripts/cutovers/run-rename.sql.
SELECT 'old tables' AS check, count(*) FROM pg_tables
WHERE schemaname = 'public' AND tablename ~ '^(ImportRun|ImportFinding)'
UNION ALL
SELECT 'old constraint names', count(*) FROM pg_constraint
WHERE conname ~ '(ImportRun|importRunId|ImportFinding)'
UNION ALL
SELECT 'old index names', count(*) FROM pg_indexes
WHERE schemaname = 'public' AND indexname ~ '(ImportRun|importRunId|ImportFinding)'
UNION ALL
SELECT 'old entity kind', count(*) FROM "Entity" WHERE kind = 'importRun'
UNION ALL
SELECT 'run rows without run identity', count(*) FROM "Run" r
LEFT JOIN "Entity" e ON e.id = r.id AND e.kind = 'run' WHERE e.id IS NULL
UNION ALL
SELECT 'old finding target', count(*) FROM "RunFinding" WHERE "targetKind" = 'import_run'
UNION ALL
SELECT 'deleted recipes with cached totals', count(*) FROM "Recipe"
WHERE "deletedAt" IS NOT NULL AND ("totals" IS NOT NULL OR "totalsComputedAt" IS NOT NULL)
UNION ALL
SELECT 'legacy grams columns', count(*) FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'grams'
  AND table_name IN ('MealFoodEntry', 'MealRecipePortion')
UNION ALL
SELECT 'missing entity FKs', 4 - count(*) FROM pg_constraint
WHERE conname IN ('RunFinding_target_fk', 'RunMutation_target_fk',
  'AiUsage_entity_fk', 'AiAnalysis_entity_fk') AND convalidated
UNION ALL
SELECT 'unvalidated constraints', count(*) FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = 'public' AND NOT c.convalidated;
