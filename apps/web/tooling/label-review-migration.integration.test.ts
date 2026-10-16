import { withMigrationDatabase } from "./test-database-lease";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";

// Contraction must preserve item evidence and stock, and retain identity exceptions.
it("retires label review without losing Product evidence, stock or identity exceptions", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) => tag.endsWith("_remove_label_review"));
    if (index < 1)
      throw new Error("Label-review contraction has no predecessor");
    await migrateDatabase(drizzle(client), {
      through: tags[index - 1]!,
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-label-member', 'Synthetic member', 'label@example.invalid')`,
    );
    const item = await client.query<{ id: string }>(
      `INSERT INTO "Product" (shortcode, name, manufacturer, notes, "labelReviewedRevision") VALUES ('PRD-4K7M', 'Synthetic Trail Shirt — Blue, M', 'Synthetic Works', 'SYNTHETIC WORKS / M / BLUE', 'label-v1:00000000000000000000000000000000') RETURNING id`,
    );
    const productId = item.rows[0]!.id;
    const location = await client.query<{ id: string }>(
      `INSERT INTO "Location" (shortcode, name, type) VALUES ('LOC-4K7M', 'Synthetic closet', 'room') RETURNING id`,
    );
    const photo = await client.query<{ id: string }>(
      `INSERT INTO "Image" (shortcode, key, filename, size, "contentType", status, source) VALUES ('IMG-4K7M', 'synthetic/label.png', 'label.png', 32, 'image/png', 'UPLOADED', 'own') RETURNING id`,
    );
    await client.query(
      `INSERT INTO "EntityAttachment" ("entityId", "entityKind", "imageId", role, purpose) VALUES ($1, 'product', $2, 'attachment', 'label')`,
      [productId, photo.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO "InventoryEntry" (shortcode, "productId", "locationId", "amountValue", "amountUnit") VALUES ('INV-4K7M', $1, $2, 1, 'each')`,
      [productId, location.rows[0]!.id],
    );
    const notesFingerprint = createHash("sha256")
      .update(JSON.stringify("SYNTHETIC WORKS / M / BLUE"))
      .digest("hex");
    await client.query(
      `INSERT INTO "EntitySource" ("entityId", "entityKind", "fieldPath", quote, "selectedVariant", "valueFingerprint", "userId", channel) VALUES ($1, 'product', 'notes', 'SYNTHETIC WORKS / M / BLUE', 'Blue, M', $2, 'synthetic-label-member', 'mcp')`,
      [productId, notesFingerprint],
    );
    for (const [check, fingerprint] of [
      ["product_label_review", "product_label_review:synthetic"],
      [
        "product_external_id",
        'product_external_id:[false, "label-v1:00000000000000000000000000000000"]',
      ],
      [
        "product_manufacturer",
        'product_manufacturer:["Synthetic Works", "label-v1:00000000000000000000000000000000"]',
      ],
      [
        "product_category",
        'product_category:[null, "label-v1:00000000000000000000000000000000"]',
      ],
      ["product_price", "product_price:null|null"],
    ]) {
      await client.query(
        `INSERT INTO "DataException" ("entityId", "entityKind", "check", reason, note, fingerprint) VALUES ($1, 'product', $2, 'unavailable', 'Synthetic exception evidence.', $3)`,
        [productId, check, fingerprint],
      );
    }
    const snapshots = new Map<string, unknown>();
    const tables = [
      "Image",
      "EntityAttachment",
      "InventoryEntry",
      "EntitySource",
    ];
    for (const table of tables)
      snapshots.set(
        table,
        (
          await client.query(
            `SELECT to_jsonb(record) - 'sourceEvidence' AS data FROM "${table}" record ORDER BY id`,
          )
        ).rows,
      );
    const before = (
      await client.query(
        `SELECT to_jsonb(p) - 'labelReviewedRevision' AS data FROM "Product" p WHERE id = $1`,
        [productId],
      )
    ).rows;
    await migrateDatabase(drizzle(client));
    expect(
      (
        await client.query(
          `SELECT to_jsonb(p) AS data FROM "Product" p WHERE id = $1`,
          [productId],
        )
      ).rows,
    ).toEqual(before);
    for (const table of tables)
      expect(
        (
          await client.query(
            `SELECT to_jsonb(record) - 'sourceEvidence' AS data FROM "${table}" record ORDER BY id`,
          )
        ).rows,
      ).toEqual(snapshots.get(table));
    expect(
      (
        await client.query(
          `SELECT "check", fingerprint, note FROM "DataException" WHERE "entityId" = $1 ORDER BY "check"`,
          [productId],
        )
      ).rows,
    ).toEqual([
      {
        check: "product_category",
        fingerprint: "product_category:null",
        note: "Synthetic exception evidence.",
      },
      {
        check: "product_external_id",
        fingerprint: "product_external_id:false",
        note: "Synthetic exception evidence.",
      },
      {
        check: "product_manufacturer",
        fingerprint: 'product_manufacturer:"Synthetic Works"',
        note: "Synthetic exception evidence.",
      },
      {
        check: "product_price",
        fingerprint: "product_price:null|null",
        note: "Synthetic exception evidence.",
      },
    ]);
  });
}, 60_000);
