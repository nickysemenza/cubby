import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// A kind-less conflict payload made its Run unreadable; clearing it must
// leave every executable fix and every other finding field untouched.
it("clears Email conflict payloads and keeps executable fixes", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261109024750_email_import_recovery",
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-finding', 'Synthetic member', 'finding@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', 'LPY-SYNFIND')`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id, shortcode, name, kind, "userId") VALUES ($1, 'LPY-SYNFIND', 'Synthetic member', 'member', 'synthetic-finding')`,
      [id(1)],
    );
    const fix = { kind: "relink_product", expenseId: id(30), productId: null };
    const findings = [
      {
        n: 10,
        entityKind: "email",
        proposedFix: {
          emailId: id(20),
          predictionId: id(21),
          conflict: { kind: "accepted_unrelated" },
        },
      },
      { n: 11, entityKind: "expense", proposedFix: fix },
      { n: 12, entityKind: "email", proposedFix: null },
    ];
    for (const finding of findings)
      await client.query(
        `INSERT INTO "RunFinding" (id, "publicationKey", "ledgerPartyId", "entityKind", "entityId", kind, summary, "proposedFix", "evidenceFingerprint", judgment)
         VALUES ($1, $2, $3, $4, $5, 'other', 'Synthetic finding', $6, $7, '{}'::jsonb)`,
        [
          id(finding.n),
          `synthetic:${finding.n}`,
          id(1),
          finding.entityKind,
          id(finding.n + 100),
          finding.proposedFix === null
            ? null
            : JSON.stringify(finding.proposedFix),
          `synthetic-fingerprint:${finding.n}`,
        ],
      );

    await migrateDatabase(db, {
      through: "20261109072002_run_finding_conflict_payload",
    });

    const { rows } = await client.query<{
      id: string;
      proposedFix: unknown;
      evidenceFingerprint: string;
      summary: string;
    }>(
      `SELECT id, "proposedFix", "evidenceFingerprint", summary FROM "RunFinding" ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        id: id(10),
        proposedFix: null,
        evidenceFingerprint: "synthetic-fingerprint:10",
        summary: "Synthetic finding",
      },
      {
        id: id(11),
        proposedFix: fix,
        evidenceFingerprint: "synthetic-fingerprint:11",
        summary: "Synthetic finding",
      },
      {
        id: id(12),
        proposedFix: null,
        evidenceFingerprint: "synthetic-fingerprint:12",
        summary: "Synthetic finding",
      },
    ]);
  });
});
