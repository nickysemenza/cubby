import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Retiring `blocked` must keep every holder Run, outcome clock and other status.
it("rewrites blocked Emails to unsettled or pending without moving holders or evidence clocks", async () => {
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
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'run', 'RUN-SYNRECOVER')`,
      [id(2)],
    );
    await client.query(
      `INSERT INTO "Run" (id, shortcode, purpose, trigger, status, "failureCode", "ledgerPartyId", "actorName", "actorEmail", "actorUserId", "actorLedgerPartyShortcode", "retiredAt")
       VALUES ($1, 'RUN-SYNRECOVER', 'mail_import', 'discovery', 'failed', 'agent_failed', $2, 'Synthetic member', 'recovery@example.test', 'synthetic-recovery', 'LPY-SYNRECOVER', '2026-01-03')`,
      [id(2), id(1)],
    );
    const emails = [
      { n: 10, status: "blocked", runId: id(2) },
      { n: 11, status: "blocked", runId: null },
      { n: 12, status: "researching", runId: id(2) },
      { n: 13, status: "completed", runId: id(2) },
    ];
    for (const { n, status, runId } of emails) {
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'email', $2)`,
        [id(n), `EML-SYNREC${n}`],
      );
      await client.query(
        `INSERT INTO "Email" (id, shortcode, "ledgerPartyId", provider, "mailboxId", "messageId", checksum, status, "runId", classification, "updatedAt")
         VALUES ($1, $2, $3, 'gmail', 'synthetic-mailbox', $4, 'synthetic-checksum', $5, $6, 'related', '2026-01-02T03:04:05.123456')`,
        [
          id(n),
          `EML-SYNREC${n}`,
          id(1),
          `synthetic-message-${n}`,
          status,
          runId,
        ],
      );
    }
    const before = await client.query(`SELECT * FROM "Email" ORDER BY id`);
    await migrateDatabase(db, {
      through: "20261109015849_email_import_recovery",
    });
    const after = await client.query(`SELECT * FROM "Email" ORDER BY id`);
    const expected = new Map([
      [id(10), "unsettled"],
      [id(11), "pending"],
      [id(12), "researching"],
      [id(13), "completed"],
    ]);
    expect(after.rows).toEqual(
      before.rows.map((row: { id: string }) => ({
        ...row,
        status: expected.get(row.id),
        orderKeys: null,
        trackingKeys: null,
        mailKeysChecksum: null,
      })),
    );
    await expect(
      client.query(`UPDATE "Email" SET status = 'blocked' WHERE id = $1`, [
        id(10),
      ]),
    ).rejects.toThrow(/Email_status_check/u);
  });
});
