import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Database } from "~/server/db";
import { createDatabase } from "~/server/db/database-runtime";
import * as schema from "~/server/db/schema";

/** Measure actual PostgreSQL wire values, before Drizzle parses JSON columns. */
export async function measureDatabaseTransfer<T>(
  databaseUrl: string,
  read: (db: Database) => Promise<T>,
) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  let largestValueBytes = 0;
  let totalBytes = 0;
  pool.on("connect", (client) =>
    client.connection.on(
      "dataRow",
      ({ fields }: { fields: (string | null)[] }) => {
        for (const value of fields) {
          if (value === null) continue;
          const bytes = Buffer.byteLength(value);
          largestValueBytes = Math.max(largestValueBytes, bytes);
          totalBytes += bytes;
        }
      },
    ),
  );
  const driver = drizzle({ client: pool, schema });
  const db = createDatabase(() => ({
    client: driver,
    withConnection: (fn) => fn(driver),
  }));
  try {
    const result = await read(db);
    return { result, largestValueBytes, totalBytes };
  } finally {
    await pool.end();
  }
}
