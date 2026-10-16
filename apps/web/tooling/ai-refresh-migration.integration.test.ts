import { withMigrationDatabase } from "./test-database-lease";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrationTags, migrateDatabase } from "./db-migrate";

// Rehearse the expansion against populated predecessor storage, never production.
it("preserves legacy decisions, member resolutions and suggestion history through AI refresh expansion", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const expansion = tags.findIndex((tag) =>
      tag.endsWith("_ai_evaluation_refresh"),
    );
    if (expansion < 1)
      throw new Error("AI refresh expansion has no predecessor");
    await migrateDatabase(drizzle(client), {
      through: tags[expansion - 1]!,
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-migration-user', 'Synthetic member', 'synthetic@example.invalid')`,
    );
    const owner = await client.query<{ id: string }>(
      `INSERT INTO "Run" (shortcode, "actorName", "actorUserId", "actorEmail", purpose, trigger, status) VALUES ('RUN-4K7M', 'Synthetic member', 'synthetic-migration-user', 'synthetic@example.invalid', 'ai_suggest', 'manual', 'completed') RETURNING id`,
    );
    const party = await client.query<{ id: string }>(
      `INSERT INTO "LedgerParty" (shortcode, name, kind, "userId") VALUES ($1, 'Synthetic member', 'member', 'synthetic-migration-user') RETURNING id`,
      [`${SHORTCODE_PREFIX.ledgerParty}-4K7M`],
    );
    const email = await client.query<{ id: string }>(
      `INSERT INTO "Email" (shortcode, "ledgerPartyId", "mailboxId", "messageId", checksum, classification, "classificationStage", "classificationReason", status) VALUES ($2, $1, 'synthetic-mailbox', 'synthetic-message', 'synthetic-checksum', 'related', 'resolution', 'Synthetic member resolution', 'completed') RETURNING id`,
      [party.rows[0]!.id, `${SHORTCODE_PREFIX.email}-4K7M`],
    );
    await client.query(
      `INSERT INTO "EmailClassificationObservation" ("emailId", "runId", checksum, classification, stage, reason) VALUES ($1, $2, 'synthetic-checksum', 'uncertain', 'decision', 'Synthetic original ambiguity')`,
      [email.rows[0]!.id, owner.rows[0]!.id],
    );
    for (const status of ["pending", "applied", "rejected", "superseded"])
      await client.query(
        `INSERT INTO "Suggestion" ("runId", entity, "recordId", field, "suggestedValue", confidence, model, kind, status, "correctValue") VALUES ($1, 'product', $2, 'notes', '"Synthetic proposal"'::jsonb, 0.8, 'typesafe/jev', 'correction', $3, '"Synthetic correction"'::jsonb)`,
        [owner.rows[0]!.id, crypto.randomUUID(), status],
      );
    const tables = [
      "Run",
      "LedgerParty",
      "Email",
      "EmailClassificationObservation",
      "Suggestion",
    ];
    const before = new Map<string, unknown>();
    for (const table of tables)
      before.set(
        table,
        (
          await client.query(
            `SELECT to_jsonb(row) AS data FROM "${table}" AS row ORDER BY id`,
          )
        ).rows,
      );
    await migrateDatabase(drizzle(client), {
      through: tags[expansion]!,
    });
    for (const table of tables) {
      const after = (
        await client.query(
          `SELECT to_jsonb(row) - ARRAY['provenance', 'evaluationId', 'acceptanceReceipt', 'supersessionReceipt'] AS data FROM "${table}" AS row ORDER BY id`,
        )
      ).rows;
      expect(after).toEqual(before.get(table));
    }
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM "AiEvaluation"`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT provenance, "acceptanceReceipt" FROM "Suggestion"`,
        )
      ).rows.every(
        (row) => row.provenance === null && row.acceptanceReceipt === null,
      ),
    ).toBe(true);
  });
});
