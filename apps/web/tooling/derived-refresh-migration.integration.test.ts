import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Expansion must preserve authoritative rows and old fingerprinted evidence;
// derived trigger retirement is a separate, post-deployment catalog change.
it("preserves populated write data through derived-refresh expansion and contraction", async () => {
  await withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expand = tags.indexOf("0098_derived_refresh_expand");
    const contract = tags.indexOf("0099_derived_refresh_contract");
    if (expand < 1 || contract !== expand + 1)
      throw new Error("Derived refresh migration boundaries are missing");
    await migrateDatabase(drizzle(client), { through: tags[expand - 1]! });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-refresh-member','Synthetic member','refresh-member@example.invalid')`);
    await client.query(`INSERT INTO "Product" (shortcode,name,manufacturer,price)
      VALUES ('PRD-4K7M','Synthetic preserved product','Synthetic maker',2.5)`);
    await client.query(`INSERT INTO "Expense" (shortcode,name,cost,date,"costType",trade,"productId","lineKind")
      SELECT 'EXP-4K7M','Synthetic preserved expense',5,'2026-01-01','materials','other',id,'principal' FROM "Product" WHERE shortcode='PRD-4K7M'`);
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId","fieldPath","valueFingerprint",url,"userId",channel)
      SELECT 'product',id,'tags',repeat('a',64),'https://example.invalid/synthetic-evidence','synthetic-refresh-member','mcp'
      FROM "Product" WHERE shortcode='PRD-4K7M'`);
    await client.query(`INSERT INTO "EntityEmbedding" ("entityKind","entityId","embeddingText","embeddingHash",provider,model,dimensions)
      SELECT 'product',id,'Synthetic preserved product','synthetic-text-hash','synthetic-provider','synthetic-model',2
      FROM "Product" WHERE shortcode='PRD-4K7M'`);
    const snapshot = async () => ({
      products: (
        await client.query(
          `SELECT to_jsonb(p) AS data FROM "Product" p ORDER BY id`,
        )
      ).rows,
      expenses: (
        await client.query(
          `SELECT to_jsonb(e) AS data FROM "Expense" e ORDER BY id`,
        )
      ).rows,
      sources: (
        await client.query(
          `SELECT to_jsonb(s) AS data FROM "EntitySource" s ORDER BY id`,
        )
      ).rows,
      embeddings: (
        await client.query(`SELECT id,"entityKind","entityId","embeddingText","embeddingHash",provider,model,dimensions,"createdAt","updatedAt","deletedAt"
        FROM "EntityEmbedding" ORDER BY id`)
      ).rows,
    });
    const before = await snapshot();
    await migrateDatabase(drizzle(client), { through: tags[expand]! });
    expect(await snapshot()).toEqual(before);
    expect(
      (await client.query(`SELECT "artifactState" FROM "EntityEmbedding"`))
        .rows,
    ).toEqual([{ artifactState: "legacy" }]);
    const legacyTrigger = async () =>
      (
        await client.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='"Product"'::regclass AND tgname='Product_supersede_suggestions_after_update'`)
      ).rows;
    expect(await legacyTrigger()).toHaveLength(1);
    // The deployed predecessor still writes its old column list during expansion.
    await client.query(`INSERT INTO "Product" (shortcode,name,manufacturer)
      VALUES ('PRD-7M4K','Synthetic predecessor write','Synthetic maker')`);
    const expanded = await snapshot();
    await migrateDatabase(drizzle(client), { through: tags[contract]! });
    expect(await snapshot()).toEqual(expanded);
    expect(await legacyTrigger()).toEqual([]);
    // Identity/liveness enforcement survives removal of derived fanout triggers.
    expect(
      (
        await client.query(
          `SELECT kind,shortcode FROM "Entity" WHERE shortcode='PRD-7M4K'`,
        )
      ).rows,
    ).toEqual([{ kind: "product", shortcode: "PRD-7M4K" }]);
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId","fieldPath",quote,"userId",channel)
      SELECT 'product',id,'tags','Synthetic recorded evidence','synthetic-refresh-member','mcp' FROM "Product" WHERE shortcode='PRD-7M4K'`);
  });
});
