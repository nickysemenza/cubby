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

it("accepts one compatible historical transaction in deterministic owner order", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, { through: "20261110195756_live_product_stock" });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await client.query(
      `INSERT INTO "ExternalSource" (slug,label) VALUES ('synthetic-bank','Synthetic bank')`,
    );
    for (const [n, kind, code] of [
      [1, "transactionImport", "TIM-SYNA"],
      [2, "sourceOccurrence", "SOC-SYNA"],
      [3, "sourceOccurrence", "SOC-SYNB"],
      [4, "sourceTransactionRecord", "STR-SYNA"],
      [5, "sourceTransactionRecord", "STR-SYNB"],
      [6, "financialAccount", "FAC-SYNA"],
      [7, "financialTransaction", "FTX-SYNA"],
    ] as const)
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [id(n), kind, code],
      );
    await client.query(
      `INSERT INTO "FinancialAccount" (id,shortcode,name,identity) VALUES ($1,'FAC-SYNA','Synthetic account','{"kind":"cash"}')`,
      [id(6)],
    );
    await client.query(
      `INSERT INTO "FinancialTransaction" (id,shortcode,"accountId",kind,status,"postedDate","amountMinor") VALUES ($1,'FTX-SYNA',$2,'purchase','posted','2026-01-01',1000)`,
      [id(7), id(6)],
    );
    await client.query(
      `INSERT INTO "TransactionImport" (id,shortcode,source,label,fingerprint) VALUES ($1,'TIM-SYNA','synthetic-bank','Synthetic','synthetic-historical')`,
      [id(1)],
    );
    for (const n of [0, 1]) {
      await client.query(
        `INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","identityProof","reviewState","accountId","createdAt") VALUES ($1,$2,'synthetic-bank','unproven',$3,'{}','unproven',$4,$5)`,
        [
          id(n + 2),
          n ? "SOC-SYNB" : "SOC-SYNA",
          `unproven-record:${n}`,
          id(6),
          `2026-01-0${n + 1}T00:00:00Z`,
        ],
      );
      await client.query(
        `INSERT INTO "SourceTransactionRecord" (id,shortcode,"batchId",source,"occurrenceId","factFingerprint","accountDescriptor","statementDate","amountMinor","providerAmountMinor","rawDescription") VALUES ($1,$2,$3,'synthetic-bank',$4,$5,'Synthetic account','2026-01-01',1000,-1000,'Synthetic charge')`,
        [
          id(n + 4),
          n ? "STR-SYNB" : "STR-SYNA",
          id(1),
          id(n + 2),
          "b".repeat(64),
        ],
      );
      await client.query(
        `UPDATE "SourceOccurrence" SET "currentObservationId"=$1 WHERE id=$2`,
        [id(n + 4), id(n + 2)],
      );
      await client.query(
        `INSERT INTO "FinancialEvidenceAlias" (source,kind,value,"observationId","occurrenceId","provenanceKey",provenance,"scopeEvidence") VALUES ('synthetic-bank','legacyExternalId','v1:synthetic',$1,$2,$3,'{}','{}')`,
        [id(n + 4), id(n + 2), `synthetic-observation-${n}`],
      );
    }
    await client.query(
      `INSERT INTO "FinancialEvidenceAlias" (source,kind,value,"historicalTransactionId","provenanceKey",provenance,"scopeEvidence") VALUES ('synthetic-bank','transaction_ref','v1:synthetic',$1,'synthetic-binding','{}','{}')`,
      [id(7)],
    );
    await migrateDatabase(db, { through: "20261110232756_unusual_fenris" });
    const owners = await client.query(
      `SELECT "identityKind","reviewState","acceptedTransactionId" FROM "SourceOccurrence" ORDER BY "createdAt",id`,
    );
    expect(owners.rows).toEqual([
      {
        identityKind: "legacy",
        reviewState: "ready",
        acceptedTransactionId: id(7),
      },
      {
        identityKind: "legacy",
        reviewState: "ready",
        acceptedTransactionId: null,
      },
    ]);
  });
});
