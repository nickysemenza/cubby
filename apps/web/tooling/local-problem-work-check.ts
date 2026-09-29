import assert from "node:assert/strict";
import { Pool } from "pg";
import { assertDevDatabaseUrl } from "./dev-db-guard.ts";

export const LOCAL_PROBLEM_FAILED_NOTE =
  "Synthetic failed photo processing fixture";
export const LOCAL_PROBLEM_PENDING_NOTE =
  "Synthetic pending photo processing fixture";

/** Verifies the durable work states and the real source-image contract. */
export async function assertLocalProblemWork(pool: Pool): Promise<void> {
  const runs = await pool.query<{
    notes: string;
    status: string;
    failureCode: string | null;
    endedAt: Date | null;
  }>(
    `SELECT notes, status, "failureCode", "endedAt" FROM "Run" WHERE notes IN ($1, $2) AND "deletedAt" IS NULL`,
    [LOCAL_PROBLEM_FAILED_NOTE, LOCAL_PROBLEM_PENDING_NOTE],
  );
  assert.equal(
    runs.rows.length,
    2,
    "Problems pack must contain explicit failed and pending Runs",
  );
  const failed = runs.rows.find(
    (row) => row.notes === LOCAL_PROBLEM_FAILED_NOTE,
  );
  const pending = runs.rows.find(
    (row) => row.notes === LOCAL_PROBLEM_PENDING_NOTE,
  );
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "flue_failed");
  assert.ok(failed.endedAt, "Failed Run must have terminal timing");
  assert.ok(pending);
  assert.equal(pending.status, "running");
  assert.equal(pending.endedAt, null, "Pending Run must remain open");
  const jobs = await pool.query<{
    state: string;
    source_matches: boolean;
    source_available: boolean;
    lastError: string | null;
  }>(
    `SELECT j.state, j."sourceContentHash" = i.sha256 AS source_matches,
      i.status = 'UPLOADED' AND i."storageStatus" = 'available' AND i."renderStatus" = 'verified' AS source_available,
      j."lastError"
     FROM "ImageProcessingJob" j JOIN "Image" i ON i.id = j."imageId"
     JOIN "Run" r ON r.id = j."runId" WHERE r.notes IN ($1, $2)`,
    [LOCAL_PROBLEM_FAILED_NOTE, LOCAL_PROBLEM_PENDING_NOTE],
  );
  assert.equal(
    jobs.rows.length,
    2,
    "Problems pack must contain failed and pending image jobs",
  );
  assert.deepEqual(jobs.rows.map((row) => row.state).sort(), [
    "failed",
    "pending",
  ]);
  assert.ok(
    jobs.rows.every((row) => row.source_matches && row.source_available),
  );
  assert.match(
    jobs.rows.find((row) => row.state === "failed")?.lastError ?? "",
    /Synthetic provider failure/,
  );
}

if (process.argv[1] === import.meta.filename) {
  const databaseUrl = process.env.DATABASE_URL;
  assertDevDatabaseUrl(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await assertLocalProblemWork(pool);
    console.log("Problems pack failed/pending source contracts verified");
  } finally {
    await pool.end();
  }
}
