import { sqlite } from "./client";

function ensureFoodSearchFts(): void {
  sqlite.exec(
    "" +
      "CREATE VIRTUAL TABLE IF NOT EXISTS food_search " +
      "USING fts5(" +
      // fdc_id and data_type are stored alongside but not indexed for full-text
      "fdc_id UNINDEXED, " +
      "data_type UNINDEXED, " +
      "description, short_description, brand_name, brand_owner, " +
      // Tokenizer: unicode with diacritics removed; porter can be added if desired
      "tokenize='unicode61 remove_diacritics 1'" +
      ");",
  );
}

export function rebuildFoodSearchFts(): void {
  ensureFoodSearchFts();

  const trx = sqlite.transaction(() => {
    sqlite.exec("DELETE FROM food_search;");

    const insertSql = `
      INSERT INTO food_search (fdc_id, data_type, description, short_description, brand_name, brand_owner)
      SELECT f.fdc_id,
             f.data_type,
             COALESCE(f.description, ''),
             COALESCE(b.short_description, ''),
             COALESCE(b.brand_name, ''),
             COALESCE(b.brand_owner, '')
      FROM usda_food f
      LEFT JOIN usda_branded_food b ON b.fdc_id = f.fdc_id;
    `;
    sqlite.exec(insertSql);

    try {
      sqlite.exec("INSERT INTO food_search(food_search) VALUES('optimize');");
    } catch {
      // Ignore FTS optimization errors - not critical
    }
  });

  trx();
}
