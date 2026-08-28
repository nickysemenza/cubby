import { readFile } from "node:fs/promises";
import type { LocationId, LocationShortcode } from "@cubby/schemas/identifiers";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { Database, type DatabaseRuntime } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";

const createDrizzle = (pg: PGlite) => drizzle<typeof schema>(pg, { schema });
type PGliteDatabase = ReturnType<typeof createDrizzle>;

type PGliteFileDb = {
  db: Database;
  rawDb: PGliteDatabase;
  pg: PGlite;
  truncateTargets: string;
};

let fileDb: PGliteFileDb | null = null;

const templatePath = () => {
  const path = process.env.CUBBY_PGLITE_TEMPLATE_PATH;
  if (!path) {
    throw new Error(
      "CUBBY_PGLITE_TEMPLATE_PATH is required for the PGlite integration project",
    );
  }
  return path;
};

const createFileDb = async (): Promise<PGliteFileDb> => {
  if (fileDb) return fileDb;

  // `loadDataDir` takes an archive, not a path. The archive is schema-only;
  // each isolated test file receives its own in-memory copy and never writes
  // back to the shared template.
  const archive = new Blob([await readFile(templatePath())]);
  const pg = await PGlite.create({
    extensions: { pg_trgm, vector },
    loadDataDir: archive,
  });
  const rawDb = createDrizzle(pg);
  const runtime: DatabaseRuntime = {
    client: rawDb,
    withConnection: (fn) => fn(rawDb),
  };
  const result = await pg.query<{ list: string | null }>(
    `SELECT string_agg(format('%I', tablename), ', ') AS list
       FROM pg_tables WHERE schemaname = 'public'`,
  );
  const truncateTargets = result.rows[0]?.list ?? "";
  if (!truncateTargets) {
    await pg.close();
    throw new Error(
      "pglite-test-db: found no public tables in the prepared template",
    );
  }

  fileDb = {
    db: new Database(() => runtime),
    rawDb,
    pg,
    truncateTargets,
  };
  return fileDb;
};

/** Restore the same baseline contract as the IntegreSQL test provider. */
export async function resetPgliteTestDb(opts: {
  user: { id: string; name: string; email: string };
  home: { id: LocationId; shortcode: LocationShortcode };
}): Promise<Database> {
  const current = await createFileDb();
  await current.pg.exec(
    `TRUNCATE ${current.truncateTargets} RESTART IDENTITY CASCADE`,
  );
  await current.rawDb.insert(schema.user).values({
    id: opts.user.id,
    name: opts.user.name,
    email: opts.user.email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await current.rawDb.insert(schema.location).values({
    id: opts.home.id,
    shortcode: opts.home.shortcode,
    name: "Home",
    aliases: [],
    type: "house",
    parentId: null,
  });
  return current.db;
}

/** Close this test file's isolated in-memory PGlite instance. */
export async function closePgliteTestDb(): Promise<void> {
  if (!fileDb) return;
  const current = fileDb;
  fileDb = null;
  await current.pg.close();
}
