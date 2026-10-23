CREATE TABLE release_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  release TEXT NOT NULL,
  state TEXT NOT NULL,
  manifest TEXT,
  next_shard INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  ready_at TEXT
);
CREATE TABLE food (
  fdc_id INTEGER PRIMARY KEY,
  data_type TEXT NOT NULL,
  description TEXT NOT NULL,
  barcode_key TEXT,
  ndb_number INTEGER,
  summary TEXT NOT NULL
);
CREATE INDEX food_barcode_key ON food (barcode_key);
CREATE INDEX food_ndb_number ON food (ndb_number);
CREATE INDEX food_description ON food (description);
CREATE INDEX food_data_type ON food (data_type, description);
CREATE TABLE food_alias (
  fdc_id INTEGER PRIMARY KEY,
  current_fdc_id INTEGER NOT NULL
) WITHOUT ROWID;
CREATE VIRTUAL TABLE food_search USING fts5(
  description, brand_name, brand_owner,
  content = '', tokenize = 'unicode61 remove_diacritics 1'
);
INSERT INTO food_search (food_search, rank) VALUES ('rank', 'bm25(1.0, 0.3, 0.3)');
