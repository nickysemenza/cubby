import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";
import * as schema from "~/server/db/schema";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";

import { migrateDatabase } from "./db-migrate";
import { createPostgresPool } from "./postgres-pool";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves populated predecessor decisions and queued work while initially publishing all six result families", async () => {
  await withMigrationDatabase(async (client, databaseUrl) => {
    const runtime = drizzle(client);
    await migrateDatabase(runtime, {
      through: "0045_field_envelope_decisions",
    });
    const pool = createPostgresPool({ connectionString: databaseUrl, max: 4 });
    try {
      const db = createDatabase(() => ({
        client: drizzle({ client: pool, schema }),
        withConnection: async (run) => {
          const connection = await pool.connect();
          try {
            return await run(drizzle({ client: connection, schema }));
          } finally {
            connection.release();
          }
        },
      }));
      const party = await insertWithShortcode(db, "ledgerParty", {
        name: "Synthetic retained member",
        kind: "member",
      });
      const product = await insertWithShortcode(db, "product", {
        name: "Synthetic retained Product",
      });
      const location = await insertWithShortcode(db, "location", {
        name: "Synthetic retained room",
        type: "room",
      });
      const inventory = await insertWithShortcode(db, "inventory", {
        productId: product.id,
        locationId: location.id,
        amountValue: 1,
        amountUnit: "count",
        ownershipMode: "explicit",
        ownerLedgerPartyId: party.id,
      });
      const project = await insertWithShortcode(db, "project", {
        name: "Synthetic retained Project",
      });
      const expense = await insertWithShortcode(db, "expense", {
        name: "Synthetic retained principal",
        projectId: project.id,
        productId: product.id,
        cost: 20,
        date: "2026-09-01",
        future: false,
        lineKind: "principal",
        costType: "materials",
        trade: "other",
      });
      await runtime.insert(schema.expenseAttribution).values({
        expenseId: expense.id,
        ledgerPartyId: party.id,
        role: "beneficiary",
        weight: 1,
      });
      const email = await insertWithShortcode(db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic@example.test",
        messageId: "synthetic-retained-message",
        checksum: "synthetic-retained-checksum",
        subject: "Synthetic retained source evidence",
        status: "completed",
        classification: "related",
      });
      const shipment = await insertWithShortcode(db, "shipment", {
        name: "Synthetic retained Shipment",
      });
      // A matching Worker can already have queued these before 0046 is applied.
      await client.query(
        `INSERT INTO "DerivedDirty"
      (target, ref, priority, attempts, "lastError", "readyAt")
      VALUES ('product.price', $1, 0, 2, 'Synthetic retry evidence', '2020-01-01'),
             ('inventory.ownership', $2, 0, 2, 'Synthetic retry evidence', '2020-01-01')
      ON CONFLICT (target, ref) DO UPDATE SET priority=0, attempts=2,
        "lastError"=EXCLUDED."lastError", "readyAt"=EXCLUDED."readyAt"`,
        [product.id, inventory.id],
      );
      const retained = async () =>
        (
          await client.query(`SELECT jsonb_build_object(
      'products', (SELECT jsonb_agg(jsonb_build_array(id,name)) FROM "Product"),
      'inventory', (SELECT jsonb_agg(jsonb_build_array(id,"productId","amountValue","amountUnit","ownershipMode","ownerLedgerPartyId")) FROM "InventoryEntry"),
      'expenses', (SELECT jsonb_agg(jsonb_build_array(id,name,cost,date,"projectId","productId")) FROM "Expense"),
      'attributions', (SELECT jsonb_agg(to_jsonb(a)) FROM "ExpenseAttribution" a),
      'emails', (SELECT jsonb_agg(jsonb_build_array(id,"ledgerPartyId","mailboxId","messageId",checksum,subject)) FROM "Email"),
      'projects', (SELECT jsonb_agg(jsonb_build_array(id,name)) FROM "Project"),
      'shipments', (SELECT jsonb_agg(jsonb_build_array(id,name)) FROM "Shipment")
    ) AS retained`)
        ).rows;
      const before = await retained();
      const queued = async () =>
        (
          await client.query(`SELECT target, ref, ticket, priority, attempts, "lastError", "readyAt"
      FROM "DerivedDirty" ORDER BY target, ref`)
        ).rows;
      const queuedBefore = await queued();
      const capturesBefore = (
        await client.query(`SELECT * FROM "JobInvalidationCapture"`)
      ).rows;
      await migrateDatabase(runtime, {
        through: "0046_remaining_derived_results",
      });
      expect(await retained()).toEqual(before);
      expect(await queued()).toEqual(expect.arrayContaining(queuedBefore));
      const capturesAfter = (
        await client.query(`SELECT * FROM "JobInvalidationCapture"`)
      ).rows;
      expect(capturesAfter).toEqual(expect.arrayContaining(capturesBefore));
      expect(capturesAfter).toHaveLength(capturesBefore.length + 1);
      expect(capturesAfter).toContainEqual(
        expect.objectContaining({ key: "derived:drain" }),
      );
      const results = [
        { entity: "product", id: product.id, key: "ownership" },
        { entity: "inventory", id: inventory.id, key: "ownership" },
        { entity: "project", id: project.id, key: "rollups" },
        { entity: "expense", id: expense.id, key: "beneficiaryResult" },
        { entity: "email", id: email.id, key: "relationshipFacts" },
        { entity: "shipment", id: shipment.id, key: "eventSummary" },
      ] as const;
      const after = await queued();
      for (const result of results)
        expect(after).toContainEqual(
          expect.objectContaining({
            target: `${result.entity}.${result.key}`,
            ref: result.id,
          }),
        );
      // Runtime readers target the current schema; predecessor assertions above
      // remain at 0046 before carrying their retained work through later cutovers.
      await migrateDatabase(runtime);
      await drainStoredDerived(db);
      for (const result of results) {
        const reads = await loadStoredDerived(
          db,
          result.entity,
          [result.id],
          [result.key],
        );
        expect(reads.get(result.id)?.get(result.key)?.resultExists).toBe(true);
      }
      expect(await retained()).toEqual(before);
    } finally {
      await pool.end();
    }
  });
}, 30_000);
