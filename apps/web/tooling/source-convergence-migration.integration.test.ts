import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Consolidation must preserve observations and hold contradictory member decisions.
it.each([false, true])(
  "consolidates Monarch identities without discarding decisions (multiple providers: %s)",
  async (multipleProviders) => {
    await withMigrationDatabase(async (client) => {
      const db = drizzle({ client, paramsInErrors: true });
      await migrateDatabase(db, {
        through: "20261110195756_live_product_stock",
      });
      const id = (n: number) =>
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      await client.query(
        `INSERT INTO "ExternalSource" (slug,label) VALUES ('monarch','Synthetic Monarch') ON CONFLICT DO NOTHING`,
      );
      for (const [n, kind, code] of [
        [1, "transactionImport", "TIM-SYNTH1"],
        [2, "transactionImport", "TIM-SYNTH2"],
        [3, "sourceOccurrence", "SOC-SYNTH1"],
        [4, "sourceOccurrence", "SOC-SYNTH2"],
        [5, "sourceTransactionRecord", "STR-SYNTH1"],
        [6, "sourceTransactionRecord", "STR-SYNTH2"],
      ] as const)
        await client.query(
          `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
          [id(n), kind, code],
        );
      for (const n of [1, 2])
        await client.query(
          `INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint,"observedAt") VALUES ($1,$2,'monarch','Synthetic export',$3,$4)`,
          [id(n), `TIM-SYNTH${n}`, `synthetic-${n}`, `2026-01-0${n}T00:00:00Z`],
        );
      await client.query(
        `INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","providerIdentity","identityProof","reviewState") VALUES ($1,'SOC-SYNTH1','monarch','provider','provider-account:synthetic','synthetic-charge','{}','ready'), ($2,'SOC-SYNTH2','monarch','unproven','unproven-record:synthetic',NULL,'{}','unproven')`,
        [id(3), id(4)],
      );
      if (multipleProviders)
        await client.query(
          `UPDATE "SourceOccurrence" SET "identityKind"='provider',"reviewState"='ready',"identityScope"='provider-account:other',"providerIdentity"='synthetic-charge' WHERE id=$1`,
          [id(4)],
        );
      await client.query(
        `UPDATE "SourceOccurrence" SET disposition='ignored',"dispositionReason"='other',"dispositionNote"='Synthetic decision' WHERE id=$1`,
        [id(4)],
      );
      for (const n of [1, 2]) {
        await client.query(
          `INSERT INTO "SourceTransactionRecord" (id,shortcode,"batchId",source,"occurrenceId","factFingerprint","providerTransactionId","accountDescriptor","statementDate","amountMinor","providerAmountMinor","rawDescription") VALUES ($1,$2,$3,'monarch',$4,$5,'synthetic-charge','Synthetic card','2026-01-01',1000,-1000,'Synthetic charge')`,
          [id(n + 4), `STR-SYNTH${n}`, id(n), id(n + 2), "a".repeat(64)],
        );
        await client.query(
          `UPDATE "SourceOccurrence" SET "currentObservationId"=$1 WHERE id=$2`,
          [id(n + 4), id(n + 2)],
        );
      }
      await migrateDatabase(db, { through: "20261110232756_unusual_fenris" });
      const owners = await client.query(
        `SELECT id,"identityKind","identityScope","reviewState","supersededByOccurrenceId" FROM "SourceOccurrence" ORDER BY id`,
      );
      const survivor = owners.rows.find(
        (owner) => owner.identityScope === "provider:monarch",
      );
      expect(survivor).toMatchObject({
        identityKind: "provider",
        reviewState: "identity_conflict",
      });
      expect(survivor?.id === id(3)).toBe(!multipleProviders);
      const retired = owners.rows.filter((owner) => owner.id !== survivor?.id);
      expect(
        retired.every(
          (owner) => owner.supersededByOccurrenceId === survivor?.id,
        ),
      ).toBe(true);
      const observations = await client.query(
        `SELECT "occurrenceId" FROM "SourceTransactionRecord" WHERE id IN ($1,$2)`,
        [id(5), id(6)],
      );
      expect(observations.rows).toEqual([
        { occurrenceId: survivor?.id },
        { occurrenceId: survivor?.id },
      ]);
    });
  },
);
