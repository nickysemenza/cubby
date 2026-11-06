import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Retained work must heal without resetting evidence, checkpoints or member controls.
it("reopens exhausted analysis and serialization work while preserving checkpoints and controls", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0108_shipment_capture_text_index" });
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
      ["other", "run.execute", "failed", "Synthetic unrelated failure"],
    ];
    for (const [key, kind, state, error] of cases)
      await client.query(
        `INSERT INTO "Job" (key,kind,input,state,attempts,"maxAttempts",cursor,result,error,"availableAt","leaseToken","leaseExpiresAt")
        VALUES ($1,$2,'{"source":"synthetic"}',$3,3,3,'{"offset":7}','{"saved":true}',$4,'2026-01-01',CASE WHEN $3 = 'running' THEN gen_random_uuid() ELSE NULL END,CASE WHEN $3 = 'running' THEN '2099-01-01'::timestamp ELSE NULL END)`,
        [key, kind, state, error],
      );
    const read = async () =>
      (
        await client.query(
          `SELECT key,kind,input,cursor,result,error,attempts,"availableAt","leaseToken","leaseExpiresAt",state,generation,"maxAttempts" FROM "Job" ORDER BY key`,
        )
      ).rows;
    const before = await read();
    await migrateDatabase(db, { through: "0109_model_input_recovery" });
    const after = await read();
    expect(
      after.map(
        ({
          state: _state,
          generation: _generation,
          maxAttempts: _maxAttempts,
          ...evidence
        }) => evidence,
      ),
    ).toEqual(
      before.map(
        ({
          state: _state,
          generation: _generation,
          maxAttempts: _maxAttempts,
          ...evidence
        }) => evidence,
      ),
    );
    const byKey = new Map(after.map((row) => [row.key, row]));
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
