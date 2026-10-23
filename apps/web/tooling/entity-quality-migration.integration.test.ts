import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// The quality migration must preserve identity, source facts and member decisions,
// including waivers whose legacy evidence signature no longer matched.
it("preserves populated identities and waivers while adding kind-checked quality rows", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0021_shipment_purpose_direction" });
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'shipment', 'SHIP-SYNTHETIC')`,
      [id],
    );
    await client.query(
      `INSERT INTO "Shipment" (id, shortcode, name) VALUES ($1, 'SHIP-SYNTHETIC', 'Synthetic retained parcel')`,
      [id],
    );
    await client.query(
      `INSERT INTO "DataException" ("entityId", "entityKind", "check", reason, note, fingerprint)
      VALUES ($1, 'shipment', 'shipment_events', 'unavailable', 'Synthetic retained decision', 'synthetic-legacy-evidence')`,
      [id],
    );
    const before = await client.query(
      `SELECT e.*, s.name, d."check", d.reason, d.note FROM "Entity" e
      JOIN "Shipment" s ON s.id = e.id JOIN "DataException" d ON d."entityId" = e.id WHERE e.id = $1`,
      [id],
    );
    expect(before.rows).toHaveLength(1);
    await migrateDatabase(db, { through: "0022_entity_quality" });
    const after = await client.query(
      `SELECT e.*, s.name, d."check", d.reason, d.note FROM "Entity" e
      JOIN "Shipment" s ON s.id = e.id JOIN "DataException" d ON d."entityId" = e.id WHERE e.id = $1`,
      [id],
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      client.query(
        `INSERT INTO "EntityQuality" ("entityId", kind, score, "rulesVersion", "computedAt")
      VALUES ($1, 'product', 100, 1, now())`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await client.query(
      `INSERT INTO "EntityQuality" ("entityId", kind, score, "rulesVersion", "computedAt")
      VALUES ($1, 'shipment', NULL, 1, now())`,
      [id],
    );
    await expect(
      client.query(
        `INSERT INTO "EntityQualityCheck" ("entityId", kind, "checkKey", state)
      VALUES ($1, 'product', 'shipment_events', 'gap')`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await client.query(
      `INSERT INTO "EntityQualityCheck" ("entityId", kind, "checkKey", state)
      VALUES ($1, 'shipment', 'shipment_events', 'gap')`,
      [id],
    );
    expect(
      (
        await client.query(
          `SELECT score FROM "EntityQuality" WHERE "entityId" = $1`,
          [id],
        )
      ).rows,
    ).toEqual([{ score: null }]);
  });
});
