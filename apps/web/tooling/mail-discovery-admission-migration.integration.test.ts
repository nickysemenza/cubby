import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Admission enforcement must preserve frozen work, paid evidence and member stops.
it("preserves populated discovery owners and excludes legacy writers across resource admission migration", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261108013714_0120_source_alias_key_lookup",
    });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-mail-migration','Synthetic member','mail-migration@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'ledgerParty','LPY-SYNMAILMIGRATION')`,
      [id(1)],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind,"userId") VALUES ($1,'LPY-SYNMAILMIGRATION','Synthetic member','member','synthetic-mail-migration')`,
      [id(1)],
    );
    const queries = [
      { key: "synthetic-query", query: "from:orders@example.test" },
    ];
    const coverage = {
      version: 1,
      baselineHistoryId: "100",
      broad: { pageToken: null, completed: false },
      scoped: [
        {
          ...queries[0],
          pageToken: "synthetic-next",
          completed: false,
          messageCount: 25,
        },
      ],
      history: { historyId: "100", pageToken: null, targetHistoryId: null },
      nextLane: "scan",
    };
    await client.query(
      `INSERT INTO "MailboxCursor" ("ledgerPartyId",provider,"mailboxId",coverage,"historyId","lastPolledAt") VALUES ($1,'gmail','synthetic-mailbox',$2,'100','2026-01-01')`,
      [id(1), coverage],
    );
    const input = {
      mailboxId: "synthetic-mailbox",
      scopedQueries: queries,
      executionPolicy: "classification_only",
      emailAuditVersion: 1,
    };
    const page = {
      messageIds: ["synthetic-original"],
      messageOffset: 0,
      events: [],
      startCoverage: coverage,
      nextCoverage: coverage,
      scopedKey: queries[0]?.key,
    };
    const owners = [
      { n: 10, status: "running", failure: null, state: "running" },
      { n: 11, status: "paused", failure: null, state: "paused" },
      {
        n: 12,
        status: "paused_auth",
        failure: "execution_limit",
        state: "queued",
      },
      {
        n: 13,
        status: "failed",
        failure: "user_cancelled",
        state: "cancelled",
      },
    ];
    for (const owner of owners) {
      const code = `RUN-SYNMAILMIGRATION${owner.n}`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run',$2)`,
        [id(owner.n), code],
      );
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"ledgerPartyId","actorName","actorUserId","actorEmail","actorLedgerPartyShortcode",trigger,purpose,status,"failureCode",input,progress,notes)
        VALUES ($1,$2,$3,'Synthetic member','synthetic-mail-migration','mail-migration@example.test','LPY-SYNMAILMIGRATION','scheduled','mail_discovery',$4,$5,$6,$7,'Synthetic retained history')`,
        [
          id(owner.n),
          code,
          id(1),
          owner.status,
          owner.failure,
          input,
          { attempt: 3, phase: "fetching", pagesDone: 2, page },
        ],
      );
      await client.query(
        `INSERT INTO "Job" (key,kind,"runId",input,cursor,state,generation,attempts,"availableAt","leaseToken","leaseExpiresAt","waitReason")
        VALUES ($1,'run.execute',$2,$3,'{"page":2}',$4,3,0,'2099-01-01',CASE WHEN $4='running' THEN gen_random_uuid() ELSE NULL END,CASE WHEN $4='running' THEN '2099-01-01'::timestamp ELSE NULL END,CASE WHEN $4='queued' THEN 'ai_funding_window' ELSE NULL END)`,
        [
          `run:${id(owner.n)}`,
          id(owner.n),
          { runId: id(owner.n), purpose: "mail_discovery" },
          owner.state,
        ],
      );
    }
    await client.query(
      `INSERT INTO "AiEvaluation" (id,"runId","workKey",feature,target,provenance,snapshot,state,result,receipt)
      VALUES ($1,$2,'synthetic-retained-paid-answer','mailbox-relevance','{"kind":"email","recordId":"synthetic-source"}','{"inputFingerprint":"synthetic-checksum"}','{"retained":"source evidence"}','result_ready','{"description":"Synthetic paid answer"}','{"retained":"paid receipt"}')`,
      [id(20), id(11)],
    );
    await client.query(
      `INSERT INTO "AiEvaluationRequest" ("runId","evaluationId",receipt) VALUES ($1,$2,'{"retained":"member receipt"}')`,
      [id(11), id(20)],
    );
    const snapshot = async () => {
      const rows = [];
      for (const table of [
        "Run",
        "Job",
        "AiEvaluation",
        "AiEvaluationRequest",
        "MailboxCursor",
      ])
        rows.push(
          (
            await client.query(
              `SELECT jsonb_agg(to_jsonb(t) - ARRAY['providerRetryAt','admissionVersion'] ORDER BY to_jsonb(t)->>'id') AS rows FROM "${table}" t`,
            )
          ).rows,
        );
      return rows;
    };
    const before = await snapshot();
    await migrateDatabase(db, {
      through: "20261108233717_mail_discovery_resources",
    });
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT "providerRetryAt","admissionVersion" FROM "MailboxCursor"`,
        )
      ).rows,
    ).toEqual([{ providerRetryAt: null, admissionVersion: 0 }]);
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNMAILCONFLICT')`,
      [id(30)],
    );
    await expect(
      client.query(
        `INSERT INTO "Run" (id,shortcode,"ledgerPartyId","actorName","actorUserId","actorEmail","actorLedgerPartyShortcode",trigger,purpose,status,input,progress)
      VALUES ($1,'RUN-SYNMAILCONFLICT',$2,'Synthetic member','synthetic-mail-migration','mail-migration@example.test','LPY-SYNMAILMIGRATION','scheduled','mail_discovery','running',$3,'{"attempt":0,"phase":"listing","discoveryScope":{"kind":"query","key":"independent-query"}}')`,
        [id(30), id(1), input],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "Run_one_active_mail_discovery",
    });
    expect(await snapshot()).toEqual(before);
  });
});
