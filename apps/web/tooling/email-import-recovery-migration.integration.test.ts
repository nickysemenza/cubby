import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const checksum = "c".repeat(64);
const revision = "d".repeat(64);

// Retiring `blocked` must keep every holder Run, outcome clock and other
// status; the attempt bound and revision fence must carry existing history,
// or the next discovery pass readmits evidence that already failed.
it("rewrites blocked Emails and carries attempt history without moving evidence clocks", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261108233717_mail_discovery_resources",
    });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-recovery', 'Synthetic member', 'recovery@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', 'LPY-SYNRECOVER')`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id, shortcode, name, kind, "userId") VALUES ($1, 'LPY-SYNRECOVER', 'Synthetic member', 'member', 'synthetic-recovery')`,
      [id(1)],
    );
    const runs = [
      { n: 2, emails: [10, 12, 13, 14], startedAt: "2026-01-01", key: null },
      { n: 3, emails: [14, 15], startedAt: "2026-01-02", key: null },
      { n: 4, emails: [14], startedAt: "2026-01-03", key: null },
      // A sender-proof recheck: its revision starts its own count.
      {
        n: 5,
        emails: [10],
        startedAt: "2026-01-04",
        key: `mail-research:${id(1)}:sender-proof:${revision}:${"e".repeat(64)}`,
      },
    ];
    for (const run of runs) {
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'run', $2)`,
        [id(run.n), `RUN-SYNRECOVER${run.n}`],
      );
      await client.query(
        `INSERT INTO "Run" (id, shortcode, purpose, trigger, status, "failureCode", "ledgerPartyId", "actorName", "actorEmail", "actorUserId", "actorLedgerPartyShortcode", "startedAt", "endedAt", input, "clientKey")
         VALUES ($1, $2, 'mail_import', 'discovery', 'failed', 'agent_failed', $3, 'Synthetic member', 'recovery@example.test', 'synthetic-recovery', 'LPY-SYNRECOVER', $4, $4, $5, $6)`,
        [
          id(run.n),
          `RUN-SYNRECOVER${run.n}`,
          id(1),
          run.startedAt,
          {
            kind: "mail_research",
            sources: run.emails.map((n) => ({
              orderMailId: id(n + 100),
              checksum,
            })),
          },
          run.key,
        ],
      );
    }
    const emails = [
      { n: 10, status: "blocked", runId: id(2) },
      { n: 11, status: "blocked", runId: null },
      { n: 12, status: "researching", runId: id(2) },
      { n: 13, status: "completed", runId: id(2) },
      { n: 14, status: "pending", runId: null },
      { n: 15, status: "pending", runId: null },
    ];
    for (const { n, status, runId } of emails) {
      await client.query(
        `INSERT INTO "OrderMail" (id, "ledgerPartyId", "rawChecksum") VALUES ($1, $2, $3)`,
        [id(n + 100), id(1), checksum],
      );
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'email', $2)`,
        [id(n), `EML-SYNREC${n}`],
      );
      await client.query(
        `INSERT INTO "Email" (id, shortcode, "ledgerPartyId", provider, "mailboxId", "messageId", checksum, status, "runId", classification, "orderMailId", "updatedAt")
         VALUES ($1, $2, $3, 'gmail', 'synthetic-mailbox', $4, $5, $6, $7, 'related', $8, '2026-01-02T03:04:05.123456')`,
        [
          id(n),
          `EML-SYNREC${n}`,
          id(1),
          `synthetic-message-${n}`,
          checksum,
          status,
          runId,
          id(n + 100),
        ],
      );
    }
    const before = await client.query(`SELECT * FROM "Email" ORDER BY id`);
    await migrateDatabase(db, {
      through: "20261109024750_email_import_recovery",
    });
    const after = await client.query(`SELECT * FROM "Email" ORDER BY id`);
    const attempts = (count: number, key = checksum) => ({
      revision: key,
      count,
    });
    const expected = new Map([
      [
        id(10),
        {
          status: "unsettled",
          importAttempts: attempts(1, `${checksum}:${revision}`),
        },
      ],
      [id(11), { status: "pending", importAttempts: null }],
      [id(12), { status: "researching", importAttempts: attempts(1) }],
      [id(13), { status: "completed", importAttempts: attempts(1) }],
      // Out of attempts: held by its latest Run for a new evidence revision.
      [
        id(14),
        { status: "unsettled", importAttempts: attempts(3), runId: id(4) },
      ],
      [id(15), { status: "pending", importAttempts: attempts(1) }],
    ]);
    expect(after.rows).toEqual(
      before.rows.map((row: { id: string }) => ({
        ...row,
        ...expected.get(row.id),
        orderKeys: null,
        trackingKeys: null,
        mailKeysChecksum: null,
      })),
    );
    const fenced = await client.query(
      `SELECT id, input->>'evidenceRevision' AS revision FROM "Run" ORDER BY id`,
    );
    expect(fenced.rows).toEqual([
      { id: id(2), revision: null },
      { id: id(3), revision: null },
      { id: id(4), revision: null },
      { id: id(5), revision },
    ]);
    await expect(
      client.query(`UPDATE "Email" SET status = 'blocked' WHERE id = $1`, [
        id(10),
      ]),
    ).rejects.toThrow(/Email_status_check/u);
  });
});
