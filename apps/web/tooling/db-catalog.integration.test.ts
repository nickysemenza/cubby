import { Client } from "pg";
import { expect, it } from "vitest";

import { diffSchemaCatalogs, readSchemaCatalog } from "./db-catalog";
import { withTestDb } from "./test-setup";

const ctx = withTestDb();

it("detects changed view bodies even when their columns are unchanged", async () => {
  const client = new Client({ connectionString: ctx.databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE "SyntheticViewSource" (value integer);
      CREATE VIEW "SyntheticCatalogView" AS SELECT value FROM "SyntheticViewSource";
      CREATE MATERIALIZED VIEW "SyntheticCatalogMaterializedView" AS SELECT 1::integer AS value;
    `);
    const expected = await readSchemaCatalog(ctx.databaseUrl);
    await client.query(`
      CREATE OR REPLACE VIEW "SyntheticCatalogView" AS SELECT value * 2 AS value FROM "SyntheticViewSource";
      DROP MATERIALIZED VIEW "SyntheticCatalogMaterializedView";
      CREATE MATERIALIZED VIEW "SyntheticCatalogMaterializedView" AS SELECT 2::integer AS value;
    `);
    const actual = await readSchemaCatalog(ctx.databaseUrl);
    expect(actual.columns).toEqual(expected.columns);
    expect(diffSchemaCatalogs(expected, actual)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("relations SyntheticCatalogView:"),
        expect.stringContaining("relations SyntheticCatalogMaterializedView:"),
      ]),
    );
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS archive;
      ALTER TABLE "SyntheticViewSource" SET SCHEMA archive;
      CREATE TABLE "SyntheticViewSource" (value integer);
    `);
    await expect(readSchemaCatalog(ctx.databaseUrl)).rejects.toThrow(
      "Public views depend on archive: SyntheticCatalogView -> archive.SyntheticViewSource",
    );
    await client.query(
      `CREATE OR REPLACE VIEW "SyntheticCatalogView" AS SELECT value * 2 AS value FROM "SyntheticViewSource"`,
    );
    expect(
      (await readSchemaCatalog(ctx.databaseUrl)).relations.SyntheticCatalogView,
    ).toBeDefined();
  } finally {
    await client.end();
  }
});

it("detects an omitted custom migration for a function or trigger", async () => {
  const client = new Client({ connectionString: ctx.databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE "SyntheticCatalogRow" (value integer);
      CREATE FUNCTION synthetic_catalog_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.value := 1; RETURN NEW; END; $$;
      CREATE TRIGGER synthetic_catalog_insert BEFORE INSERT ON "SyntheticCatalogRow"
        FOR EACH ROW EXECUTE FUNCTION synthetic_catalog_trigger();
    `);
    const expected = await readSchemaCatalog(ctx.databaseUrl);
    await client.query(`
      CREATE OR REPLACE FUNCTION synthetic_catalog_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.value := 2; RETURN NEW; END; $$;
      DROP TRIGGER synthetic_catalog_insert ON "SyntheticCatalogRow";
    `);
    expect(
      diffSchemaCatalogs(expected, await readSchemaCatalog(ctx.databaseUrl)),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("functions synthetic_catalog_trigger():"),
        expect.stringContaining(
          'triggers "SyntheticCatalogRow".synthetic_catalog_insert:',
        ),
      ]),
    );
  } finally {
    await client.end();
  }
});
