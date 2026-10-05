import { seedBaseWorld } from "../../tooling/factories/base-world";
import {
  type DatabaseLease,
  leaseDatabase,
} from "../../tooling/test-database-lease";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Check out one seeded browser-worker database after global setup has
 * prepared the `browser` template.
 */
export async function createE2EDatabase(): Promise<DatabaseLease> {
  console.log("[E2E Worker] Getting fresh database from IntegreSQL...");
  const { lease } = await leaseDatabase("browser", async ({ databaseUrl }) => {
    const seedPool = new Pool({ connectionString: databaseUrl });
    try {
      // Seeded in the checked-out database rather than the IntegreSQL template
      // so a cached older template is repaired before a worker starts.
      await seedBaseWorld(drizzleNodePostgres(seedPool));
      // Every worker must start without corpus products, regardless of shard.
      const { rows } = await seedPool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM "Product"',
      );
      if (rows[0]?.count !== "0") {
        throw new Error("E2E database checkout contains corpus products");
      }
    } finally {
      await seedPool.end();
    }
  });
  console.log(`[E2E Worker] Using PostgreSQL database: ${lease.name}`);
  return lease;
}
