import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";

// Retiring execution approvals must keep approval-root Runs and their receipts
// as history, strip only the stale reference keys strict inputs now refuse,
// close unfinished discovery passes so none resumes under a retired scope or
// holds the one-active-discovery slot, and drop legacy Vendor-name queries from
// mailbox coverage without moving history or other query positions.
it("expands safely, then strips approval references and retires legacy discovery in the staged contraction", async () => {
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
    await insertRun(
      "00000000-0000-4000-8000-0000000000a5",
      "RUN-6P7Q",
      "mail_discovery",
      "running",
      {
        mailboxId: "synthetic-second-mailbox",
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    );
    const position = { pageToken: null, completed: false };
    const history = {
      historyId: "110",
      pageToken: "synthetic-history-page",
      targetHistoryId: "120",
    };
    await client.query(
      `INSERT INTO "MailboxCursor" ("ledgerPartyId","mailboxId",coverage)
        VALUES ($1,'synthetic-mailbox',$2)`,
      [
        party,
        JSON.stringify({
          version: 1,
          baselineHistoryId: "100",
          broad: position,
          scoped: [
            {
              key: "vendor:00000000-0000-4000-8000-0000000000c1",
              query: '{"Synthetic Shop" from:orders@shop.example.test}',
              ...position,
            },
            {
              key: "charge:00000000-0000-4000-8000-0000000000c2",
              query: '"SYNTHETIC SHOP"',
              pageToken: "synthetic-charge-page",
              completed: false,
            },
            {
              key: "vendor:00000000-0000-4000-8000-0000000000c1:from:orders@shop.example.test",
              query: "from:orders@shop.example.test",
              pageToken: null,
              completed: true,
            },
          ],
          history,
          nextLane: "history",
        }),
      ],
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
    const snapshot = async () => ({
      runs: (await client.query(`SELECT * FROM "Run" ORDER BY shortcode`)).rows,
      cursors: (await client.query(`SELECT * FROM "MailboxCursor"`)).rows,
      evaluations: (await client.query(`SELECT * FROM "AiEvaluation"`)).rows,
    });
    const predecessor = await snapshot();

    // The expansion is safe under the predecessor Worker: it changes no data.
    await migrateDatabase(drizzle(client), {
      through: "0081_automatic_mail_import",
    });
    expect(await snapshot()).toEqual(predecessor);
    expect(
      (
        await client.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'AiUsage_createdAt_idx'`,
        )
      ).rowCount,
    ).toBe(1);
    // The new Worker can start an import pass before the contraction runs.
    await insertRun(
      "00000000-0000-4000-8000-0000000000a6",
      "RUN-7R8S",
      "mail_discovery",
      "running",
      {
        mailboxId: "synthetic-third-mailbox",
        scopedQueries: [],
        executionPolicy: "import",
        emailAuditVersion: 1,
      },
    );

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
      failureCode: "discovery_policy_replaced",
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
    expect(runs["RUN-6P7Q"]).toMatchObject({
      status: "completed",
      failureCode: "discovery_policy_replaced",
    });
    expect(runs["RUN-7R8S"]).toMatchObject({
      status: "running",
      failureCode: null,
    });
    const [cursor] = (
      await client.query(`SELECT coverage FROM "MailboxCursor"`)
    ).rows;
    expect(cursor.coverage).toMatchObject({
      baselineHistoryId: "100",
      history,
      nextLane: "history",
    });
    expect(
      cursor.coverage.scoped.map((query: { key: string }) => query.key),
    ).toEqual([
      "charge:00000000-0000-4000-8000-0000000000c2",
      "vendor:00000000-0000-4000-8000-0000000000c1:from:orders@shop.example.test",
    ]);
    expect(cursor.coverage.scoped[0]).toMatchObject({
      pageToken: "synthetic-charge-page",
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
