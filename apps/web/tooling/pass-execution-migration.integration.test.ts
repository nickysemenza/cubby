import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("carries interrupted discovery, dispatch, funding and snapshot work without changing Run checkpoints", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, { through: "20261113120002_ask_funding_wakes" });
    const party = crypto.randomUUID();
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'ledgerParty', 'LPY-SYNTH')`,
      [party],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id, shortcode, name, kind) VALUES ($1, 'LPY-SYNTH', 'Synthetic member', 'member')`,
      [party],
    );
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-member', 'Synthetic member', 'synthetic@example.test')`,
    );
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const event = crypto.randomUUID();
    const checkpoint = { attempt: 4, pagesDone: 2, page: { messageOffset: 9 } };
    for (const [index, id] of ids.entries()) {
      const purpose = index === 3 ? "mail_import" : "mail_discovery";
      const status =
        index === 2 ? "paused" : index === 3 ? "paused_auth" : "running";
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'run', $2)`,
        [id, `RUN-SYNTH${index}`],
      );
      await client.query(
        `INSERT INTO "Run" (id, shortcode, "ledgerPartyId", "actorLedgerPartyShortcode", "actorName", trigger, "actorUserId", "actorEmail", purpose, status, "failureCode", input, progress, "dispatchEventId", "coordinatorStartedAt") VALUES ($1,$2,$3,'LPY-SYNTH','Synthetic member','manual','synthetic-member','synthetic@example.test',$4,$5,$6,jsonb_build_object('mailboxId', $9::text),$7,$8,now())`,
        [
          id,
          `RUN-SYNTH${index}`,
          party,
          purpose,
          status,
          index === 2
            ? "user_cancelled"
            : index === 3
              ? "execution_limit"
              : null,
          JSON.stringify(checkpoint),
          index === 3 ? event : crypto.randomUUID(),
          `synthetic-mailbox-${index}`,
        ],
      );
    }
    const until = "2099-01-01T00:00:00.000Z";
    for (const [index, id] of ids.entries()) {
      if (index === 3) continue;
      await client.query(
        `INSERT INTO "Job" (key,kind,"runId",input,cursor,generation,attempts,"maxAttempts",state,"availableAt","leaseExpiresAt",error) VALUES ($1,'run.execute',$2,$3,$4,4,2,5,$5,'2098-01-01',$6,'Synthetic interrupted page')`,
        [
          `synthetic:${index}`,
          id,
          JSON.stringify({ runId: id, purpose: "mail_discovery" }),
          JSON.stringify({ index: 2 }),
          index === 0
            ? "running"
            : index === 2
              ? "cancelled"
              : index === 4
                ? "failed"
                : "retry_wait",
          index === 0 ? until : null,
        ],
      );
    }
    const dispatch = {
      version: 1,
      runId: ids[3],
      purpose: "mail_import",
      eventId: event,
      generation: event,
      type: "start_or_resume",
    };
    await client.query(
      `INSERT INTO "Job" (key,kind,"runId",input) VALUES ('synthetic:dispatch','purchase.dispatch',$1,$2),('synthetic:funding','run.funding-resume',$1,$3)`,
      [
        ids[3],
        JSON.stringify(dispatch),
        JSON.stringify({ runId: ids[3], until }),
      ],
    );
    await client.query(
      `INSERT INTO "DerivedRebuild" (key,running,target,"afterId","cursorAttempts",pages,"processedRecords","leaseExpiresAt","startedAt") VALUES ('deterministic',true,'product',$1,2,3,150,'2099-01-01','2026-01-01') ON CONFLICT (key) DO UPDATE SET running=excluded.running,target=excluded.target,"afterId"=excluded."afterId","cursorAttempts"=excluded."cursorAttempts",pages=excluded.pages,"processedRecords"=excluded."processedRecords","leaseExpiresAt"=excluded."leaseExpiresAt","startedAt"=excluded."startedAt"`,
      [ids[0]],
    );

    await migrateDatabase(db, {
      through: "20261113120003_pass_execution_state",
    });
    const { rows } = await client.query(
      `SELECT name,key,cursor,attempts,"maxAttempts",to_char("availableAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "availableAt","waitCause","cancelledAt" IS NOT NULL AS cancelled FROM "Pass"`,
    );
    const mail = (index: number) =>
      rows.find((row) => row.name === "run.execute" && row.key === ids[index]);
    expect(mail(0)).toMatchObject({
      cursor: { generation: 4, page: { index: 2 } },
      attempts: 2,
      maxAttempts: 5,
      availableAt: until,
      waitCause: "in_flight",
      cancelled: false,
    });
    expect(mail(2)?.cancelled).toBe(true);
    expect(mail(4)?.attempts).toBe(5);
    expect(rows.find((row) => row.name === "purchase.dispatch")).toMatchObject({
      cursor: { events: [dispatch] },
      availableAt: until,
      waitCause: "funding",
    });
    expect(rows.find((row) => row.name === "derived.snapshot")).toMatchObject({
      cursor: {
        target: "product",
        afterId: ids[0],
        cursorAttempts: 2,
        pages: 3,
        processedRecords: 150,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(
      (await client.query(`SELECT progress FROM "Run"`)).rows.map(
        (row) => row.progress,
      ),
    ).toEqual(ids.map(() => checkpoint));
    const location = crypto.randomUUID();
    await client.query(
      `INSERT INTO "Job" (key,kind,input,cursor,generation,attempts,"maxAttempts",state,"availableAt","leaseExpiresAt","waitReason") VALUES ('synthetic:inventory','location-ai.inventory.refresh',$1,$2,3,2,5,'running','2098-01-01','2099-01-01','ai_funding_window')`,
      [
        JSON.stringify({ locationId: location, runId: ids[0] }),
        JSON.stringify({ page: 2 }),
      ],
    );
    await client.query(
      `INSERT INTO "AppSettings" (id,metadata) VALUES ('6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91',$1) ON CONFLICT (id) DO UPDATE SET metadata=excluded.metadata`,
      [JSON.stringify({ after: location, nextAt: until })],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,input,"runId",state,"waitReason","availableAt") VALUES ('synthetic:description','location-ai.description.refresh',$1,$2,'paused',NULL,'2099-01-01'),('synthetic:summary','run-ai.summary.write',$3,$2,'retry_wait','ai_funding_window','2099-01-01')`,
      [
        JSON.stringify({ locationId: location }),
        ids[0],
        JSON.stringify({ runId: ids[0] }),
      ],
    );
    await migrateDatabase(db);
    expect(
      (
        await client.query(
          `SELECT cursor,attempts,"maxAttempts","waitCause",to_char("availableAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline FROM "Pass" WHERE name='location.inventory'`,
        )
      ).rows,
    ).toMatchObject([
      {
        cursor: {
          locationId: location,
          runId: ids[0],
          generation: 3,
          page: { page: 2 },
        },
        attempts: 2,
        maxAttempts: 5,
        waitCause: "funding",
        deadline: until,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT cursor FROM "Pass" WHERE name='email.purchase-discovery'`,
        )
      ).rows,
    ).toEqual([{ cursor: { after: location } }]);
    expect(
      (await client.query(`SELECT progress FROM "Run"`)).rows.map(
        (row) => row.progress,
      ),
    ).toEqual(ids.map(() => checkpoint));
    expect(
      (
        await client.query(
          `SELECT key,cursor,"waitCause","cancelledAt" IS NOT NULL AS cancelled FROM "Pass" WHERE name='fields.reconcile' ORDER BY key`,
        )
      ).rows,
    ).toMatchObject([
      {
        key: "synthetic:description",
        cursor: { key: `location:${location}`, runId: ids[0] },
        cancelled: true,
      },
      {
        key: "synthetic:summary",
        cursor: { key: `run:${ids[0]}`, runId: ids[0] },
        waitCause: "funding",
        cancelled: false,
      },
    ]);
    expect(
      (await client.query(`SELECT to_regclass('"Job"') AS present`)).rows[0]
        ?.present,
    ).toBeNull();
    expect(
      (await client.query(`SELECT to_regclass('"DerivedRebuild"') AS table`))
        .rows[0]?.table,
    ).toBeNull();
  });
});

it("does not revive a failed Run job that spent fewer than its attempt ceiling", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113054519_kernel_ownership_and_provenance",
    });
    const { seedCutoverPredecessor, cutoverId } =
      await import("./accepted-input-cutover.fixtures");
    await seedCutoverPredecessor(client);
    await client.query(`UPDATE "Run" SET status='running' WHERE id=$1`, [
      cutoverId(14),
    ]);
    await client.query(
      `INSERT INTO "Job" (key,kind,"runId",input,state,attempts,"maxAttempts",error) VALUES ('synthetic:failed-run','run.execute',$1,'{}','failed',0,5,'Synthetic terminal failure')`,
      [cutoverId(14)],
    );
    await migrateDatabase(db, {
      through: "20261113065151_workflow_pass_intent",
    });
    expect(
      (
        await client.query(
          `SELECT attempts,"maxAttempts","lastError",attempts<"maxAttempts" claimable FROM "Pass" WHERE name='run.execute' AND key=$1`,
          [cutoverId(14)],
        )
      ).rows,
    ).toEqual([
      {
        attempts: 5,
        maxAttempts: 5,
        lastError: "Synthetic terminal failure",
        claimable: false,
      },
    ]);
  });
});
