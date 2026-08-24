import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "~/server/repo/database-helpers";
import { findSearchHits } from "~/server/services/search.service";
import { withTestDb } from "./test-setup";

const SEARCH_DOCUMENT_SQL = sql`
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
`;

describe("Postgres lexical-search contract used for the PGlite benchmark", () => {
  const ctx = withTestDb();

  it("runs the same real query against the IntegreSQL template", async () => {
    await getDb(ctx.db).execute(SEARCH_DOCUMENT_SQL);
    const hits = await findSearchHits(ctx.db, {
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
