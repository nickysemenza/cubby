import type { Pool } from "pg";

/** One synthetic barcode answer so the lookup path is exercised without upstream calls. */
export async function seedUpcLookupFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO "UpcLookupCache" (upc, name, manufacturer, brand, category, description, "priceDollars", source, status, "fetchedAt")
     VALUES ('012345678905', 'Synthetic cotton shirt', 'Synthetic Works', 'Synthetic', 'Clothing', 'Local synthetic barcode fixture', 18, 'manual', 'ready', now())
     ON CONFLICT (upc) DO NOTHING`,
  );
}
