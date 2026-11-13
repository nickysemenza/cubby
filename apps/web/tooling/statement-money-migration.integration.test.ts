import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it.each([false, true])(
  "preserves every accepted occurrence and refuses unresolved live acceptance (deleted=%s)",
  async (deleted) => {
    await withMigrationDatabase(async (client) => {
      const db = drizzle({ client, paramsInErrors: true });
      await migrateDatabase(db, {
        through: "20261113105727_embedding-image-asks",
      });
      const account = crypto.randomUUID(),
        transaction = crypto.randomUUID();
      const occurrences = [crypto.randomUUID(), crypto.randomUUID()];
      await client.query(
        `INSERT INTO "ExternalSource" (slug,label) VALUES ('synthetic-a','Synthetic A'),('synthetic-b','Synthetic B')`,
      );
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'financialAccount','FAC-SYNTH1'),($2,'financialTransaction','FTX-SYNTH1'),($3,'sourceOccurrence','SOC-SYNTH1'),($4,'sourceOccurrence','SOC-SYNTH2')`,
        [account, transaction, ...occurrences],
      );
      await client.query(
        `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) VALUES ($1,'FAC-SYNTH1','Synthetic account','{"kind":"cash"}')`,
        [account],
      );
      await client.query(
        `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,"postedDate","amountMinor","deletedAt") VALUES ($1,'FTX-SYNTH1',$2,'purchase','posted','2026-01-01',1234,$3)`,
        [transaction, account, deleted ? new Date() : null],
      );
      await client.query(
        `INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","providerIdentity","identityProof","reviewState","acceptedTransactionId") VALUES ($1,'SOC-SYNTH1','synthetic-a','provider','synthetic-a','one','{}','ready',$3),($2,'SOC-SYNTH2','synthetic-b','provider','synthetic-b','one','{}','ready',$3)`,
        [...occurrences, transaction],
      );
      const migration = migrateDatabase(db, {
        through: "20261113120000_statement_money_evidence",
      });
      const result = await migration.then(
        () => "applied",
        (error) => String(error),
      );
      expect(result).toContain(
        deleted ? "unresolved accepted transaction" : "applied",
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "SourceOccurrence" WHERE "acceptedTransactionId"=$1`,
            [transaction],
          )
        ).rows,
      ).toEqual([{ n: 2 }]);
      if (deleted) return;
      expect(
        (
          await client.query(
            `SELECT "scopeKey","entityId" FROM "RecordKey" WHERE entity='financialTransaction' ORDER BY "scopeKey"`,
          )
        ).rows,
      ).toEqual(
        occurrences
          .sort()
          .map((id) => ({ scopeKey: id, entityId: transaction })),
      );
      expect(
        (
          await client.query(
            `SELECT payload->>'amount' amount FROM "ManualEntry" WHERE id=$1`,
            [transaction],
          )
        ).rows,
      ).toEqual([{ amount: "12.3400000000000000" }]);
    });
  },
);
