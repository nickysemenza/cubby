import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrationTags, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Retiring `paused_approval` must keep every Run and operation row: a held Run
// becomes a member pause that still owns its vendor-account slot, and its
// never-executed operations fail while completed receipts stay untouched.
it("moves approval-paused Runs and operations to their replacements", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_retire_paused_approval"),
    );
    if (index < 1)
      throw new Error("Paused-approval retirement has no predecessor");
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "user" (id, name, email) VALUES ('synthetic-approval-member', 'Synthetic member', 'approval@example.test')`,
    );
    await client.query(
      `INSERT INTO "LedgerParty" (shortcode, name, kind, "userId") VALUES ('LPY-4K7M', 'Synthetic member', 'member', 'synthetic-approval-member')`,
    );
    await client.query(
      `INSERT INTO "Vendor" (shortcode, name) VALUES ('VEN-4K7M', 'Synthetic store')`,
    );
    await client.query(
      `INSERT INTO "VendorAccount" (shortcode, "vendorId", "ledgerPartyId") SELECT 'VACCT-4K7M', v.id, p.id FROM "Vendor" v, "LedgerParty" p`,
    );
    await client.query(
      `INSERT INTO "Run" (shortcode, trigger, status, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId")
       SELECT v.shortcode, 'manual', v.status, 'synthetic-approval-member', 'Synthetic member', 'approval@example.test', 'LPY-4K7M', CASE WHEN v.owns THEN a.id END, a."ledgerPartyId"
       FROM "VendorAccount" a CROSS JOIN (VALUES
         ('RUN-4K7M', 'paused_approval', true),
         ('RUN-7M4K', 'completed', false)
       ) AS v(shortcode, status, owns)`,
    );
    await client.query(
      `INSERT INTO "RunOperation" ("runId", "operationId", kind, "inputFingerprint", state, result, error)
       SELECT r.id, v.operation, 'mcp:synthetic.apply', 'synthetic-input', v.state, v.result::jsonb, v.error
       FROM "Run" r JOIN (VALUES
         ('RUN-4K7M', 'synthetic-held', 'paused_approval', '{"approvalProposal":{"operationKind":"mcp:synthetic.apply"}}', NULL),
         ('RUN-7M4K', 'synthetic-done', 'completed', '{"synthetic":"receipt"}', NULL)
       ) AS v(run, operation, state, result, error) ON v.run = r.shortcode`,
    );
    const runs = async () =>
      (
        await client.query(
          `SELECT to_jsonb(r) - 'updatedAt' AS data FROM "Run" r ORDER BY shortcode`,
        )
      ).rows;
    const operations = async () =>
      (
        await client.query(
          `SELECT to_jsonb(o) - 'updatedAt' AS data FROM "RunOperation" o ORDER BY "operationId"`,
        )
      ).rows;
    const runsBefore = await runs();
    const operationsBefore = await operations();

    await migrateDatabase(drizzle(client), { through: tags[index]! });

    expect(await runs()).toEqual(
      runsBefore.map(({ data }) => ({
        data:
          data.shortcode === "RUN-4K7M" ? { ...data, status: "paused" } : data,
      })),
    );
    expect(await operations()).toEqual(
      operationsBefore.map(({ data }) => ({
        data:
          data.operationId === "synthetic-held"
            ? {
                ...data,
                state: "failed",
                error: "Approval pause retired before the operation ran",
              }
            : data,
      })),
    );
    await expect(
      client.query(
        `INSERT INTO "Run" (shortcode, trigger, status, "actorUserId", "actorName", "actorEmail", "actorLedgerPartyShortcode", "vendorAccountId", "ledgerPartyId") SELECT 'RUN-K7M4', 'manual', 'running', 'synthetic-approval-member', 'Synthetic member', 'approval@example.test', 'LPY-4K7M', a.id, a."ledgerPartyId" FROM "VendorAccount" a`,
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "Run_one_active_vendor_account_key",
    });
    await expect(
      client.query(
        `UPDATE "Run" SET status = 'paused_approval' WHERE shortcode = 'RUN-7M4K'`,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "Run_status_check" });
  });
});

// The image retry budget starts from failures since the latest operator retry,
// so a long-failing pending job does not regain a full budget on deploy.
it("seeds each live image job's failures since its latest retry", async () => {
  return withMigrationDatabase(async (client) => {
    const tags = migrationTags();
    const index = tags.findIndex((tag) =>
      tag.endsWith("_retire_paused_approval"),
    );
    await migrateDatabase(drizzle(client), { through: tags[index - 1]! });
    await client.query(
      `INSERT INTO "Image" (shortcode, key, filename, size, "contentType", status, sha256) VALUES ('IMG-4K7M', 'synthetic/original.png', 'synthetic.png', 10, 'image/png', 'UPLOADED', 'synthetic-hash')`,
    );
    await client.query(
      `INSERT INTO "ImageProcessingJob" (shortcode, "imageId", kind, state, "sourceContentHash", "processorRevision", attempts, "completedAt")
       SELECT v.shortcode, i.id, v.kind, v.state, 'synthetic-hash', v.revision, v.attempts, CASE WHEN v.state = 'failed' THEN now() END
       FROM "Image" i CROSS JOIN (VALUES
         ('IPR-4K7M', 'describe_image', 'pending', 5, 1),
         ('IPR-7M4K', 'subject_lift', 'failed', 4, 1),
         ('IPR-9P3Q', 'describe_image', 'pending', 9, 2),
         ('IPR-3Q9P', 'describe_image', 'waiting_for_device', 1, 3)
       ) AS v(shortcode, kind, state, attempts, revision)`,
    );
    await client.query(
      `INSERT INTO "ImageProcessingSubmission" (id) VALUES (gen_random_uuid())`,
    );
    await client.query(
      `INSERT INTO "ImageProcessingSubmissionJob" ("submissionId", "jobId", disposition, "baselineAttempts")
       SELECT s.id, j.id, 'retry', 3 FROM "ImageProcessingSubmission" s, "ImageProcessingJob" j WHERE j.shortcode = 'IPR-4K7M'`,
    );

    await migrateDatabase(drizzle(client), { through: tags[index]! });

    expect(
      (
        await client.query(
          `SELECT shortcode, attempts, "failuresSinceRetry" FROM "ImageProcessingJob" ORDER BY shortcode`,
        )
      ).rows,
    ).toEqual([
      { shortcode: "IPR-3Q9P", attempts: 1, failuresSinceRetry: 1 },
      { shortcode: "IPR-4K7M", attempts: 5, failuresSinceRetry: 2 },
      { shortcode: "IPR-7M4K", attempts: 4, failuresSinceRetry: 0 },
      // Past the cap under the old uncapped loop: still keeps one try.
      { shortcode: "IPR-9P3Q", attempts: 9, failuresSinceRetry: 2 },
    ]);
  });
});
