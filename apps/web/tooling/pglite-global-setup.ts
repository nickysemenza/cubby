import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/server/db/schema";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";

/**
 * Prepare one schema-complete PGlite data directory for the PGlite integration
 * project. Each test file loads a private copy in `pglite-test-db.ts`, so this
 * setup cost is paid once without sharing mutable database state between files.
 */
export default async function setupPgliteTemplate() {
  const templatePath = process.env.CUBBY_PGLITE_TEMPLATE_PATH;
  if (!templatePath) {
    throw new Error(
      "CUBBY_PGLITE_TEMPLATE_PATH is required for the PGlite integration project",
    );
  }

  const pg = await PGlite.create({ extensions: { pg_trgm, vector } });
  const db = drizzle(pg, { schema });
  try {
    await pg.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
      "public",
    ]);
    await apply();

    const archive = await pg.dumpDataDir("gzip");
    await mkdir(dirname(templatePath), { recursive: true });
    await writeFile(templatePath, Buffer.from(await archive.arrayBuffer()));
  } finally {
    await pg.close();
  }

  return async () => {
    await rm(templatePath, { force: true });
  };
}
