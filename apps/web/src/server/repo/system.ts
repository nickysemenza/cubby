import { type Database, type Transaction } from "~/server/db";
import { withTransaction } from "~/server/repo/database-helpers";
import { loadLocations } from "~/server/repo/location";
import { loadProducts } from "~/server/repo/product";
import { type OrganizationId } from "~/schemas/identifiers";
import { type transformConfig } from "~/schemas/config";

/**
 * Insert configuration data (products and locations) in a single transaction
 */
export const insertDataConfig = async (
  db: Database,
  input: ReturnType<typeof transformConfig>,
  organizationId: OrganizationId,
) => {
  return await withTransaction(db, async (tx: Transaction) => {
    await loadProducts(tx, input.products, organizationId);
    await loadLocations(tx, input.locations, organizationId);
  });
};
