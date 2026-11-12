import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Failure modes: a Run that still owes an Email an outcome, or holds another
// open finding, reads completed; a settled Run stays stuck in review.
it("completes only Mail imports whose every admitted Email has an outcome", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, { through: "20261110232756_unusual_fenris" });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const party = id(1);
    const identity = (entityId: string, kind: string, code: string) =>
      client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [entityId, kind, code],
      );
    await identity(party, "ledgerParty", "LPY-SYNTH1");
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-member','Synthetic member','synthetic-member@example.test')`);
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind) VALUES ($1,'LPY-SYNTH1','Synthetic member','member')`,
      [party],
    );
    // Mail 11/12 belong to the settled Run, 13 to the Run missing an outcome,
    // 14 to the Run with another open finding.
    for (const n of [11, 12, 13, 14]) {
      await client.query(
        `INSERT INTO "OrderMail" (id,"ledgerPartyId","rawChecksum")
         VALUES ($1,$2,$3)`,
        [id(n), party, String(n).repeat(32).slice(0, 64)],
      );
      await identity(id(n + 10), "email", `EML-SYNTH${n}`);
      await client.query(
        `INSERT INTO "Email" (id,shortcode,"ledgerPartyId","mailboxId","messageId",checksum,status,"orderMailId")
         VALUES ($1,$2,$3,'synthetic-mailbox',$4,$5,'unsettled',$6)`,
        [
          id(n + 10),
          `EML-SYNTH${n}`,
          party,
          `message-${n}`,
          String(n).repeat(32).slice(0, 64),
          id(n),
        ],
      );
    }
    const runs = [
      { n: 31, mails: [11, 12], outcomes: [11, 12], other: false },
      { n: 32, mails: [13], outcomes: [], other: false },
      { n: 33, mails: [14], outcomes: [14], other: true },
    ];
    for (const run of runs) {
      await identity(id(run.n), "run", `RUN-SYNTH${run.n}`);
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"ledgerPartyId","actorLedgerPartyShortcode","actorName",trigger,"actorUserId","actorEmail",purpose,status,input,"endedAt")
         VALUES ($1,$2,$3,'LPY-SYNTH1','Synthetic member','discovery','synthetic-member','synthetic-member@example.test','mail_import','needs_review',$4,now())`,
        [
          id(run.n),
          `RUN-SYNTH${run.n}`,
          party,
          JSON.stringify({
            kind: "mail_research",
            sources: run.mails.map((n) => ({
              orderMailId: id(n),
              checksum: String(n).repeat(32).slice(0, 64),
            })),
          }),
        ],
      );
      for (const mail of run.outcomes)
        await client.query(
          `INSERT INTO "RunOperation" ("runId","operationId",kind,"inputFingerprint",state,result,"completedAt")
           VALUES ($1,$2,'target_outcome','synthetic','completed',$3,now())`,
          [
            id(run.n),
            `mail-outcome:${mail}`,
            JSON.stringify({
              target: { entityKind: "email", entityId: id(mail + 10) },
            }),
          ],
        );
      for (const kind of run.other
        ? ["unresolved_targets", "other"]
        : ["unresolved_targets"])
        await client.query(
          `INSERT INTO "RunFinding" ("publicationKey","runId","ledgerPartyId","entityKind","entityId",kind,summary,"evidenceFingerprint",judgment)
           VALUES ($1,$2,$3,'run',$2,$4,'Synthetic finding','synthetic','{}'::jsonb)`,
          [`${run.n}:${kind}`, id(run.n), party, kind],
        );
    }

    await migrateDatabase(db, {
      through: "20261111012540_mail_import_outcomes",
    });

    const { rows: runRows } = await client.query<{
      shortcode: string;
      status: string;
    }>(`SELECT shortcode, status FROM "Run" ORDER BY shortcode`);
    expect(runRows).toEqual([
      { shortcode: "RUN-SYNTH31", status: "completed" },
      { shortcode: "RUN-SYNTH32", status: "needs_review" },
      { shortcode: "RUN-SYNTH33", status: "needs_review" },
    ]);
    const { rows: findings } = await client.query<{
      publicationKey: string;
      status: string;
      active: boolean;
      authority: string | null;
    }>(
      `SELECT "publicationKey", status, active, resolutions->0->>'authority' AS authority
       FROM "RunFinding" ORDER BY "publicationKey"`,
    );
    expect(findings).toEqual([
      {
        publicationKey: "31:unresolved_targets",
        status: "resolved",
        active: false,
        authority: "automatic",
      },
      {
        publicationKey: "32:unresolved_targets",
        status: "pending",
        active: true,
        authority: null,
      },
      {
        publicationKey: "33:other",
        status: "pending",
        active: true,
        authority: null,
      },
      {
        publicationKey: "33:unresolved_targets",
        status: "pending",
        active: true,
        authority: null,
      },
    ]);
    const { rows: emails } = await client.query<{ status: string }>(
      `SELECT DISTINCT status FROM "Email"`,
    );
    expect(emails).toEqual([{ status: "unsettled" }]);
  });
});

// Failure modes: a photo Run started before causes were recorded stays
// uncaused, or a Run's AI summary cannot be stored.
it("records member-started photo Runs and accepts Run AI analyses", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261111192147_statement_sweep_indexes",
    });
    const party = "00000000-0000-4000-8000-000000000001";
    const photoRun = "00000000-0000-4000-8000-000000000041";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'ledgerParty','LPY-SYNTH1'), ($2,'run','RUN-SYNTH41')`,
      [party, photoRun],
    );
    await client.query(`INSERT INTO "user" (id,name,email)
      VALUES ('synthetic-member','Synthetic member','synthetic-member@example.test')`);
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind) VALUES ($1,'LPY-SYNTH1','Synthetic member','member')`,
      [party],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"ledgerPartyId","actorLedgerPartyShortcode","actorName",trigger,"actorUserId","actorEmail",purpose,status)
       VALUES ($1,'RUN-SYNTH41',$2,'LPY-SYNTH1','Synthetic member','manual','synthetic-member','synthetic-member@example.test','photo_inventory','running')`,
      [photoRun, party],
    );

    await migrateDatabase(db, {
      through: "20261111235138_run_redesign_indexes",
    });

    const { rows } = await client.query<{ cause: string | null }>(
      `SELECT cause FROM "Run" WHERE id = $1`,
      [photoRun],
    );
    expect(rows).toEqual([{ cause: "member_request" }]);
    await client.query(
      `INSERT INTO "AiAnalysis" ("entityKind","entityId",feature,model,"promptVersion","inputFingerprint",result)
       VALUES ('run',$1,'run-summary','synthetic-model','v1','synthetic','{}'::jsonb)`,
      [photoRun],
    );
  });
});
