import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database as CubbyDatabase } from "~/server/db";
import type { DatabaseRuntime } from "~/server/db/database";
import * as schema from "~/server/db/schema";
import { findSearchHits } from "~/server/services/search.service";
import { toPushSchemaDatabase } from "./drizzle-kit-interop";

const pg = await PGlite.create({ extensions: { pg_trgm, vector } });
const db = drizzle(pg, { schema });
const runtime: DatabaseRuntime = {
  client: db,
  withConnection: (fn) => fn(db),
};
const cubbyDb = new CubbyDatabase(() => runtime);

afterAll(async () => {
  await pg.close();
});

beforeAll(async () => {
  await pg.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
    "public",
  ]);
  await apply();
});

describe("PGlite full Cubby schema", () => {
  it("initializes pg_trgm/vector and runs the production lexical search query", async () => {
    await db.execute(sql`
      INSERT INTO "SearchDocument" (
        id, "entityType", "entityId", shortcode, title, aliases, keywords,
        body, "semanticText", "normalizedText", "searchVector", "sourceHash"
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'product',
        '22222222-2222-4222-8222-222222222222', 'PRD-2222', 'Bench Hammer',
        ARRAY['shop hammer'], ARRAY['forged steel'], 'A forged steel bench hammer',
        'A forged steel bench hammer', 'bench hammer forged steel',
        to_tsvector('simple', 'Bench Hammer forged steel'), 'pglite-search-contract'
      )
    `);

    const hits = await findSearchHits(cubbyDb, {
      query: "hammer",
      entityTypes: ["product"],
    });
    expect(hits).toEqual([
      expect.objectContaining({
        id: "PRD-2222",
        entityType: "product",
        title: "Bench Hammer",
        matchField: "title",
      }),
    ]);
  });
});
