-- Never-expiring cache of resolved USDA foods, keyed by (dataset version, fdc_id).
-- USDA food records are immutable per dataset version, so a hot fdc_id can be
-- served straight from D1 instead of re-reading R2 + re-parsing on every lookup.
-- Version-scoped so a dataset re-import transparently uses a fresh cache.
-- The edge worker also creates this lazily (CREATE TABLE IF NOT EXISTS) as a
-- safety net for environments where migrations haven't been applied.
CREATE TABLE IF NOT EXISTS food_cache (
  version TEXT NOT NULL,
  fdc_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (version, fdc_id)
);
