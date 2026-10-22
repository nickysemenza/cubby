import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { aiBudgetWindow } from "../src/server/ai/budget-window";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Predecessor fixtures preserve dispatch diagnostics, accepted starts and funding
// pauses while transport and its redundant accounting are retired together.
it("preserves populated dispatch history and pending intent through the Job cutover", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0006_financial_evidence_entities" });
    const ids = [1, 2, 3, 4].map(
      (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-dispatch','Synthetic operator','dispatch@example.test')`,
    );
    const party = "00000000-0000-4000-8000-000000000090";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'ledgerParty','LPY-SYNTH90')`,
      [party],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind,"userId") VALUES ($1,'LPY-SYNTH90','Synthetic member','member','synthetic-dispatch')`,
      [party],
    );
    for (const [index, id] of ids.entries()) {
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run',$2)`,
        [id, `RUN-SYNTH${index}`],
      );
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status,"dispatchEventId","dispatchAttempts","dispatchError","coordinatorStartedAt","failureCode","ledgerPartyId","actorLedgerPartyShortcode")
        VALUES ($1,$2,'Synthetic operator','manual','synthetic-dispatch','dispatch@example.test','mail_import',$3,$4,$5,$6,$7,$8,$9,'LPY-SYNTH90')`,
        [
          id,
          `RUN-SYNTH${index}`,
          index === 2
            ? "dispatch_failed"
            : index === 3
              ? "paused_auth"
              : "running",
          `synthetic-event-${index}`,
          index + 1,
          index === 2 ? "Synthetic exhausted delivery" : null,
          index === 1 ? new Date() : null,
          index === 3 ? "execution_limit" : null,
          party,
        ],
      );
    }
    await client.query(`INSERT INTO "Job" (key,kind,input,state,attempts,error) VALUES
      ('synthetic-retained-page','embedding.refresh','{"entityKind":"product","entityId":"00000000-0000-4000-8000-000000000099"}','retry_wait',2,'Synthetic provider diagnostic')`);
    await migrateDatabase(db);
    const history = await client.query(
      `SELECT "entityId",changes FROM "AuditLog" WHERE "entityKind"='run' ORDER BY "entityId"`,
    );
    expect(history.rows).toEqual(
      ids.map((id, index) => ({
        entityId: id,
        changes: { dispatchAttempts: { from: index + 1, to: null } },
      })),
    );
    const intents = await client.query(
      `SELECT "runId",state,attempts,error FROM "Job" WHERE kind='purchase.dispatch' ORDER BY "runId"`,
    );
    expect(intents.rows).toEqual([
      { runId: ids[0], state: "queued", attempts: 0, error: null },
      {
        runId: ids[2],
        state: "failed",
        attempts: 3,
        error: "Synthetic exhausted delivery",
      },
    ]);
    const funding = await client.query(
      `SELECT "runId","waitReason",to_char("waitUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline FROM "Job" WHERE kind='run.funding-resume'`,
    );
    expect(funding.rows).toEqual([
      {
        runId: ids[3],
        waitReason: "ai_funding_window",
        deadline: new Date(
          aiBudgetWindow().end.getTime() + 60_000,
        ).toISOString(),
      },
    ]);
    const retained = await client.query(
      `SELECT state,attempts,error,"subjectKind","subjectId" FROM "Job" WHERE key='synthetic-retained-page'`,
    );
    expect(retained.rows[0]).toEqual({
      state: "retry_wait",
      attempts: 2,
      error: "Synthetic provider diagnostic",
      subjectKind: "product",
      subjectId: "00000000-0000-4000-8000-000000000099",
    });
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='Run' AND column_name='dispatchAttempts'`,
    );
    expect(columns.rowCount).toBe(0);
    const runs = await client.query(
      `SELECT id,status,"coordinatorStartedAt" IS NOT NULL AS started FROM "Run" ORDER BY id`,
    );
    expect(runs.rows).toEqual(
      ids.map((id, index) => ({
        id,
        status:
          index === 2
            ? "dispatch_failed"
            : index === 3
              ? "paused_auth"
              : "running",
        started: index === 1,
      })),
    );
  });
});
