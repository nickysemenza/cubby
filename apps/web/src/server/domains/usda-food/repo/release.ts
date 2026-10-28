import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";

/** A release can revise food facts without changing a Product's linked food ID. */
export async function invalidateProductFoodsForRelease(
  db: Database,
): Promise<void> {
  await unwrapDb(db).execute(sql`
    SELECT derived_mark('product.food', ARRAY(
      SELECT ${product.id} FROM ${product} WHERE ${notDeleted(product)}
    ))`);
}
