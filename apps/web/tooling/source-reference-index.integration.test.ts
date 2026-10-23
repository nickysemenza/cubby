import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Rehearse both the deployed prefix and the immediate stacked predecessor.
// Shared legacy references and noncurrent observations must remain independent.
it.each([
  "0013_photo_regroup_source_evidence",
  "0014_shipment_tracking",
  "0015_statement_label_cursor_work",
])(
  "preserves populated source references and pending work from %s",
  async (through) => {
    await withMigrationDatabase(async (client) => {
      const db = drizzle(client);
      await migrateDatabase(db, { through });
      const id = (n: number) =>
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const runId = id(1);
      const importId = id(2);
      const externalId = (n: number) =>
        `v3:${n.toString(16).padStart(64, "0")}`;
      const legacy = `v1:${"a".repeat(64)}`;
      await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-index','Synthetic operator','index@example.test')`);
      await client.query(
        `INSERT INTO "ExternalSource" (slug,label) VALUES ('synthetic-bank','Synthetic bank'),('other-bank','Other synthetic bank')`,
      );
      for (const [entityId, kind, shortcode] of [
        [runId, "run", "RUN-SYNTHINDEX"],
        [importId, "transactionImport", "TIM-SYNTHINDEX"],
      ])
        await client.query(
          `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
          [entityId, kind, shortcode],
        );
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status)
      VALUES ($1,'RUN-SYNTHINDEX','Synthetic operator','manual','synthetic-index','index@example.test','sweep','running')`,
        [runId],
      );
      await client.query(
        `INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint)
      VALUES ($1,'TIM-SYNTHINDEX','synthetic-bank','Synthetic retained export','synthetic-index-export')`,
        [importId],
      );
      for (let n = 0; n < 6; n++) {
        const rowId = id(10 + n);
        const shortcode = `STR-SYNTHINDEX${n}`;
        await client.query(
          `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'sourceTransactionRecord',$2)`,
          [rowId, shortcode],
        );
        await client.query(
          `INSERT INTO "SourceTransactionRecord"
        (id,shortcode,"batchId",source,"externalId","legacyReference","chargeKey","current","withdrawnAt","deletedAt","accountDescriptor","statementDate",amount,"providerAmount","rawDescription")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Synthetic card','2026-01-01',20,-20,'Synthetic retained charge')`,
          [
            rowId,
            shortcode,
            importId,
            n === 5 ? "other-bank" : "synthetic-bank",
            externalId(n),
            n === 3 ? null : n === 4 ? `v1:${"b".repeat(64)}` : legacy,
            `independent-charge-${n}`,
            n !== 1,
            n === 1 ? new Date("2026-01-02T00:00:00Z") : null,
            n === 2 ? new Date("2026-01-03T00:00:00Z") : null,
          ],
        );
        await client.query(
          `INSERT INTO "TransactionImportRecord" ("importId","statementRowId") VALUES ($1,$2)`,
          [importId, rowId],
        );
      }
      await client.query(
        `INSERT INTO "RunStep" ("runId",key,label,position,state,found,done,pages,cursor)
      VALUES ($1,'statement_generate','Synthetic generation',0,'running',6,2,1,'{"source":"synthetic-bank","chargeKey":"independent-charge-1"}')`,
        [runId],
      );
      await client.query(
        `INSERT INTO "Job" (key,kind,input,"runId",state,attempts,error)
      VALUES ('synthetic-index-job','run.execute',$2::jsonb,$1,'retry_wait',2,'Synthetic interrupted execution')`,
        [runId, JSON.stringify({ runId })],
      );
      const paused =
        await client.query(`UPDATE "AutomaticRule" SET enabled=false
      WHERE family='statement_transaction' AND "ruleKey"='statement_transaction.attach'`);
      expect(paused.rowCount).toBe(1);
      await client.query(
        `INSERT INTO "AppSettings" (metadata) VALUES ('{"syntheticBudgetUsd":1}')`,
      );
      const retained = async () => {
        const snapshots: unknown[] = [];
        for (const table of [
          "Entity",
          "user",
          "SourceTransactionRecord",
          "TransactionImport",
          "TransactionImportRecord",
          "Run",
          "RunStep",
          "Job",
          "AutomaticRule",
          "AppSettings",
        ]) {
          const result = await client.query<{ records: unknown }>(
            `SELECT jsonb_agg(to_jsonb(retained) ORDER BY to_jsonb(retained)::text) AS records FROM "${table}" retained`,
          );
          snapshots.push(result.rows[0]?.records);
        }
        return snapshots;
      };
      const before = await retained();
      await migrateDatabase(db, {
        through: "0016_source_legacy_reference_lookup",
      });
      expect(await retained()).toEqual(before);
      // Canonical journal bookkeeping also makes the same boundary idempotent.
      await migrateDatabase(db, {
        through: "0016_source_legacy_reference_lookup",
      });
      expect(await retained()).toEqual(before);
      const matches = await client.query<{ externalId: string }>(
        `SELECT "externalId" FROM "SourceTransactionRecord"
      WHERE source='synthetic-bank' AND "legacyReference"=$1 AND "deletedAt" IS NULL ORDER BY "externalId"`,
        [legacy],
      );
      expect(matches.rows).toEqual([
        { externalId: externalId(0) },
        { externalId: externalId(1) },
      ]);
      const index = await client.query<{
        unique: boolean;
        valid: boolean;
      }>(`SELECT i.indisunique AS unique,i.indisvalid AS valid FROM pg_index i
      JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='SourceTransactionRecord_source_legacyReference_idx'`);
      expect(index.rows).toEqual([{ unique: false, valid: true }]);
    });
  },
);
