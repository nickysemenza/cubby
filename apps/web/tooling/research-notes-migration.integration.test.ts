import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Copy/drop must retain editable notes and every excerpt, including deleted and merged owners.
it("moves citation content into existing notes before retiring Sources", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0099_derived_refresh_contract",
    });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-notes-member','Synthetic member','notes-member@example.invalid')`);
    await client.query(`INSERT INTO "Product" (shortcode,name,manufacturer,notes)
      VALUES ('PRD-4K7M','Synthetic research product','Synthetic maker',E'Original notes\nKeep whitespace.  '),
      ('PRD-7M4K','Synthetic deleted product','Synthetic maker',NULL)`);
    await client.query(
      `UPDATE "Product" SET "deletedAt"=now() WHERE shortcode='PRD-7M4K'`,
    );
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId","fieldPath",url,quote,"selectedVariant","observedAt","userId",channel,"oauthClientId","createdAt")
      SELECT 'product',id,'model','https://example.invalid/specification','Synthetic A12 excerpt','Blue','2026-01-02','synthetic-notes-member','mcp','synthetic-client','2026-01-03'
      FROM "Product" WHERE shortcode='PRD-4K7M'`);
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId",quote,"sourceEntityId","sourceEntityKind","userId",channel)
      SELECT 'product',p.id,'Synthetic quote-only research',NULL,NULL,'synthetic-notes-member','web' FROM "Product" p WHERE shortcode='PRD-7M4K'`);
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId",quote,"sourceEntityId","sourceEntityKind","userId",channel)
      SELECT 'product',p.id,'Synthetic internal reference',target.id,'product','synthetic-notes-member','mcp'
      FROM "Product" p CROSS JOIN "Product" target WHERE p.shortcode='PRD-4K7M' AND target.shortcode='PRD-7M4K'`);
    await client.query(
      `INSERT INTO "Product" (shortcode,name,manufacturer) VALUES ('PRD-7K4M','Synthetic merged donor','Synthetic maker')`,
    );
    await client.query(
      `UPDATE "Entity" SET "deletedAt"=now(), "mergedIntoId"=(SELECT id FROM "Product" WHERE shortcode='PRD-4K7M') WHERE shortcode='PRD-7K4M'`,
    );
    await client.query(
      `INSERT INTO "EntitySource" ("entityKind","entityId",quote,"userId",channel) SELECT 'product',id,'Synthetic merged-owner research','synthetic-notes-member','mcp' FROM "Product" WHERE shortcode='PRD-7K4M'`,
    );
    const tag = migrationTags().find((value) =>
      value.endsWith("_research_notes"),
    );
    if (!tag) throw new Error("Research notes migration missing");
    await migrateDatabase(drizzle(client), { through: tag });
    const rows = (
      await client.query(
        `SELECT shortcode,notes FROM "Product" ORDER BY shortcode`,
      )
    ).rows;
    expect(rows[0].notes).toMatch(/^Original notes\nKeep whitespace\.  \n/);
    for (const text of [
      "https://example.invalid/specification",
      "Synthetic A12 excerpt",
      "Blue",
      "2026-01-02",
      "model",
      "synthetic-notes-member",
      "synthetic-client",
      "PRD-7M4K",
      "Synthetic internal reference",
      "Synthetic merged-owner research",
      "PRD-7K4M",
    ])
      expect(rows[0].notes).toContain(text);
    expect(rows.find((row) => row.shortcode === "PRD-7M4K")?.notes).toContain(
      "Synthetic quote-only research",
    );
    expect(
      (
        await client.query(
          `SELECT to_regclass('public."EntitySource"') AS retired`,
        )
      ).rows,
    ).toEqual([{ retired: null }]);
    const preserved = rows;
    await migrateDatabase(drizzle(client), { through: tag });
    expect(
      (
        await client.query(
          `SELECT shortcode,notes FROM "Product" ORDER BY shortcode`,
        )
      ).rows,
    ).toEqual(preserved);
  });
});

// Durable identity can survive its payload; an unmappable citation must prevent the entire DROP.
it("refuses to retire Sources when an owner has no notes destination", async () => {
  await withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0099_derived_refresh_contract",
    });
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-orphan-member','Synthetic member','orphan-member@example.invalid')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode,"deletedAt") VALUES ('11111111-1111-4111-8111-111111111111','product','PRD-4K7M',now())`,
    );
    await client.query(`INSERT INTO "EntitySource" ("entityKind","entityId",quote,"userId",channel)
      VALUES ('product','11111111-1111-4111-8111-111111111111','Synthetic orphan research','synthetic-orphan-member','mcp')`);
    const tag = migrationTags().find((value) =>
      value.endsWith("_research_notes"),
    );
    if (!tag) throw new Error("Research notes migration missing");
    await expect(
      migrateDatabase(drizzle(client), { through: tag }),
    ).rejects.toThrow(/notes destination/);
    expect(
      (await client.query(`SELECT quote FROM "EntitySource"`)).rows,
    ).toEqual([{ quote: "Synthetic orphan research" }]);
  });
});
