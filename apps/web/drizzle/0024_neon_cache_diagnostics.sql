-- Neon diagnostics are host-specific; local pgvector Postgres has no neon extension.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'neon') THEN
    CREATE EXTENSION IF NOT EXISTS neon;
  ELSE
    RAISE NOTICE 'Skipping neon diagnostics: extension unavailable on this host';
  END IF;
END
$$;
