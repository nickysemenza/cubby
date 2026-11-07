import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Retained work must heal without resetting evidence, checkpoints or member controls.
it("reopens exhausted analysis and serialization work while preserving checkpoints and controls", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261106060922_0108_shipment_capture_text_index",
    });
    const cases = [
      [
        "location",
        "location-ai.description.refresh",
        "failed",
        "Synthetic image failure",
      ],
      [
        "inventory",
        "location-ai.inventory.refresh",
        "retry_wait",
        "Synthetic image failure",
      ],
      [
        "conflict",
        "run.execute",
        "failed",
        '{"causes":[{"message":"Synthetic AssessmentCorrectionLock email-evidence-write","code":"40001"}]}',
      ],
      [
        "paused",
        "run.execute",
        "paused",
        '{"causes":[{"message":"Synthetic AssessmentCorrectionLock email-evidence-write","code":"40001"}]}',
      ],
      [
        "cancelled",
        "location-ai.description.refresh",
        "cancelled",
        "Synthetic image failure",
      ],
      [
        "location-paused",
        "location-ai.inventory.refresh",
        "paused",
        "Synthetic image failure",
      ],
      [
        "running",
        "location-ai.inventory.refresh",
        "running",
        "Synthetic image failure",
      ],
      [
        "location-future",
        "location-ai.inventory.refresh",
        "failed",
        "Synthetic image failure",
      ],
      ["other", "run.execute", "failed", "Synthetic unrelated failure"],
    ];
    for (const [key, kind, state, error] of cases)
      await client.query(
        `INSERT INTO "Job" (key,kind,input,state,attempts,"maxAttempts",cursor,result,error,"availableAt","leaseToken","leaseExpiresAt")
        VALUES ($1,$2,'{"source":"synthetic"}',$3,3,3,'{"offset":7}','{"saved":true}',$4,'2026-01-01',CASE WHEN $3 = 'running' THEN gen_random_uuid() ELSE NULL END,CASE WHEN $3 = 'running' THEN '2099-01-01'::timestamp ELSE NULL END)`,
        [key, kind, state, error],
      );
    await client.query(
      `UPDATE "Job" SET "availableAt" = '2099-01-01' WHERE key='location-future'`,
    );
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-recovery','Synthetic member','recovery@example.test')`,
    );
    const owners = [
      ["recover", "failed", "job_failed", null],
      ["stopped", "failed", "user_cancelled", null],
      ["paused-owner", "paused", null, null],
      ["completed-owner", "completed", null, null],
      ["retired-owner", "failed", "job_failed", "2026-01-01"],
      ["superseded-owner", "failed", "job_failed", null],
    ];
    const ownerIds = owners.map(
      (_, index) => `00000000-0000-4000-8000-00000000070${index}`,
    );
    for (const [
      index,
      [key, status, failureCode, retiredAt],
    ] of owners.entries()) {
      const id = ownerIds[index];
      const code = `RUN-SYNRECOVERY${index}`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status,"failureCode","endedAt","retiredAt",progress)
        VALUES ($1,$2,'Synthetic member','manual','maintenance','synthetic-recovery','recovery@example.test',$3,$4,'2026-01-01',$5,'{"retained":"synthetic"}')`,
        [id, code, status, failureCode, retiredAt],
      );
      await client.query(
        `INSERT INTO "Job" (key,kind,"runId",input,state,attempts,"maxAttempts",cursor,result,error,"availableAt")
        VALUES ($1,'run.execute',$2,'{"source":"synthetic"}','failed',3,3,'{"offset":7}','{"saved":true}',$3,'2026-01-01')`,
        [
          key,
          id,
          '{"causes":[{"message":"Synthetic AssessmentCorrectionLock email-evidence-write","code":"40001"}]}',
        ],
      );
    }
    const successor = "00000000-0000-4000-8000-000000000799";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNSUCCESSOR')`,
      [successor],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status,"predecessorRunId")
      VALUES ($1,'RUN-SYNSUCCESSOR','Synthetic member','manual','maintenance','synthetic-recovery','recovery@example.test','running',$2)`,
      [successor, ownerIds[5]],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state,cursor) VALUES ($1,'synthetic-step','Synthetic step',0,'running','{"offset":7}')`,
      [ownerIds[0]],
    );
    const readOwners = async () =>
      (await client.query(`SELECT * FROM "Run" ORDER BY id`)).rows;
    const ownersBefore = await readOwners();
    const stepsBefore = (await client.query(`SELECT * FROM "RunStep"`)).rows;
    const read = async () =>
      (
        await client.query(
          `SELECT key,kind,input,cursor,result,error,attempts,"availableAt","leaseToken","leaseExpiresAt",state,generation,"maxAttempts" FROM "Job" ORDER BY key`,
        )
      ).rows;
    const before = await read();
    await migrateDatabase(db, {
      through: "20261106160341_0109_model_input_recovery",
    });
    const after = await read();
    expect(
      after.map(
        ({
          state: _state,
          generation: _generation,
          maxAttempts: _maxAttempts,
          availableAt: _availableAt,
          ...evidence
        }) => evidence,
      ),
    ).toEqual(
      before.map(
        ({
          state: _state,
          generation: _generation,
          maxAttempts: _maxAttempts,
          availableAt: _availableAt,
          ...evidence
        }) => evidence,
      ),
    );
    const byKey = new Map(after.map((row) => [row.key, row]));
    expect(
      (
        await client.query(
          `SELECT "availableAt" BETWEEN now() - interval '1 minute' AND now() + interval '15 minutes' AS staggered FROM "Job" WHERE key='location'`,
        )
      ).rows[0]?.staggered,
    ).toBe(true);
    for (const previous of before.filter((row) => row.key !== "location"))
      expect(byKey.get(previous.key)?.availableAt).toEqual(
        previous.availableAt,
      );
    expect(await readOwners()).toEqual(ownersBefore);
    expect((await client.query(`SELECT * FROM "RunStep"`)).rows).toEqual(
      stepsBefore,
    );
    expect(byKey.get("recover")).toMatchObject({
      state: "retry_wait",
      generation: 2,
    });
    for (const [key] of owners.slice(1))
      expect(byKey.get(key)?.state).toBe("failed");
    expect(byKey.get("location")).toMatchObject({
      state: "retry_wait",
      maxAttempts: null,
      generation: 2,
    });
    expect(byKey.get("inventory")).toMatchObject({
      state: "retry_wait",
      maxAttempts: null,
      generation: 1,
    });
    expect(byKey.get("conflict")).toMatchObject({
      state: "retry_wait",
      maxAttempts: 4,
      generation: 2,
    });
    for (const key of [
      "paused",
      "location-paused",
      "cancelled",
      "running",
      "other",
    ])
      expect(byKey.get(key)?.state).toBe(
        before.find((row) => row.key === key)?.state,
      );
  });
});
