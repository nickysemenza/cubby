import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";

// Retiring execution approvals must keep approval-root Runs and their receipts
// as history, strip only the stale reference keys strict inputs now refuse, and
// close unfinished Vendor-history passes so none resumes or holds the
// one-active-discovery slot. Completed history and unrelated input survive.
it("strips approval references and retires unfinished Vendor history across the migration", async () => {
  return withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0080_run_operation_audit_cover",
    });
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-mail-import','Synthetic member','mail@example.invalid')`);
    const party = "00000000-0000-4000-8000-0000000000b1";
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind,"userId")
        VALUES ($1,'LPY-8M9N','Synthetic member','member','synthetic-mail-import')`,
      [party],
    );
    const reference = {
      runId: "00000000-0000-4000-8000-0000000000a1",
      approvalFingerprint: "a".repeat(64),
    };
    const insertRun = (
      id: string,
      shortcode: string,
      purpose: string,
      status: string,
      input: unknown,
    ) =>
      client.query(
        `INSERT INTO "Run"
          (id,shortcode,"actorName","actorUserId","actorEmail","ledgerPartyId","actorLedgerPartyShortcode",purpose,trigger,status,input)
          VALUES ($1,$2,'Synthetic member','synthetic-mail-import','mail@example.invalid',$6,'LPY-8M9N',$3,'manual',$4,$5)`,
        [id, shortcode, purpose, status, JSON.stringify(input), party],
      );
    const approval = {
      kind: "execution_authorization",
      version: 1,
      scope: { kind: "pilot", mailboxId: "synthetic-mailbox" },
    };
    await insertRun(
      reference.runId,
      "RUN-2A3B",
      "background",
      "completed",
      approval,
    );
    await client.query(
      `INSERT INTO "RunOperation" ("runId","operationId",kind,state,"inputFingerprint",result)
        VALUES ($1,'metered:synthetic','execution_authorization','completed',$2,'{"kind":"metered_reservation"}')`,
      [reference.runId, "b".repeat(64)],
    );
    const reclassify = "00000000-0000-4000-8000-0000000000a2";
    await insertRun(reclassify, "RUN-3C4D", "mail_reclassify", "paused_auth", {
      kind: "mail_reclassify",
      mode: "relevance",
      mailboxId: "synthetic-mailbox",
      executionAuthorization: reference,
      emails: [],
    });
    await insertRun(
      "00000000-0000-4000-8000-0000000000a3",
      "RUN-4E5F",
      "mail_discovery",
      "running",
      {
        mailboxId: "synthetic-mailbox",
        scopedQueries: [],
        executionPolicy: "import",
        executionAuthorization: reference,
        vendorHistory: { generation: "synthetic", resolvedAt: null },
      },
    );
    await insertRun(
      "00000000-0000-4000-8000-0000000000a4",
      "RUN-5G6H",
      "mail_discovery",
      "completed",
      {
        mailboxId: "synthetic-mailbox",
        scopedQueries: [],
        vendorHistory: { generation: "finished", resolvedAt: null },
      },
    );
    await client.query(
      `INSERT INTO "AiEvaluation" ("runId","workKey",feature,target,provenance,snapshot,"executionKind")
        VALUES ($1,'synthetic-work','mailbox-relevance','{}','{}',$2,'mail_reclassify')`,
      [
        reclassify,
        JSON.stringify({
          publicId: "EML-7J8K",
          checksum: null,
          decisionModel: "typesafe/jev",
          executionAuthorization: reference,
          authorizationHistory: [reference],
          minimumBudgetMicroUSD: 100,
        }),
      ],
    );
    const receipts = async () =>
      (await client.query(`SELECT * FROM "RunOperation"`)).rows;
    const beforeReceipts = await receipts();

    await migrateDatabase(drizzle(client));

    const runs = Object.fromEntries(
      (
        await client.query(
          `SELECT shortcode,status,"failureCode",input FROM "Run" ORDER BY shortcode`,
        )
      ).rows.map((row) => [row.shortcode, row]),
    );
    expect(runs["RUN-2A3B"]).toMatchObject({
      status: "completed",
      input: approval,
    });
    expect(runs["RUN-3C4D"]).toMatchObject({
      status: "paused_auth",
      input: {
        kind: "mail_reclassify",
        mode: "relevance",
        mailboxId: "synthetic-mailbox",
        emails: [],
      },
    });
    expect(runs["RUN-3C4D"]?.input).not.toHaveProperty(
      "executionAuthorization",
    );
    expect(runs["RUN-4E5F"]).toMatchObject({
      status: "completed",
      failureCode: "vendor_history_retired",
      input: {
        mailboxId: "synthetic-mailbox",
        scopedQueries: [],
        executionPolicy: "import",
      },
    });
    expect(runs["RUN-4E5F"]?.input).not.toHaveProperty("vendorHistory");
    expect(runs["RUN-5G6H"]).toMatchObject({
      status: "completed",
      failureCode: null,
      input: { mailboxId: "synthetic-mailbox", scopedQueries: [] },
    });
    expect(
      (await client.query(`SELECT snapshot FROM "AiEvaluation"`)).rows,
    ).toEqual([
      {
        snapshot: {
          publicId: "EML-7J8K",
          checksum: null,
          decisionModel: "typesafe/jev",
        },
      },
    ]);
    expect(await receipts()).toEqual(beforeReceipts);
  });
});
