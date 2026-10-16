import { withMigrationDatabase } from "./test-database-lease";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";

// The cutover must keep every job's UUID (queue and lease identity), state,
// lease, attempts, events and submission memberships, while giving each job a
// fresh public code with a matching Entity identity.
it("keeps image job work and leases through the Image job entity cutover", async () => {
  return withMigrationDatabase(async (client) => {
    await migrateDatabase(drizzle(client), {
      through: "0060_photo-import-lifecycle",
    });
    await client.query(
      `INSERT INTO "Image" (id,shortcode,key,filename,size,"contentType",status,sha256) VALUES (gen_random_uuid(),'IMG-4K7M','synthetic/original.png','synthetic.png',10,'image/png','UPLOADED','synthetic-hash')`,
    );
    await client.query(`INSERT INTO "ImageProcessingJob"
      (id,"imageId",kind,state,"sourceContentHash","processorRevision",attempts,"attemptId","leaseExpiresAt","dispatchedAt")
      SELECT gen_random_uuid(),id,'subject_lift','leased','synthetic-hash',1,1,gen_random_uuid(),now() + interval '5 minutes',now() FROM "Image"`);
    await client.query(`INSERT INTO "ImageProcessingJob"
      (id,"imageId",kind,state,"sourceContentHash","processorRevision",attempts,"completedAt","lastError")
      SELECT gen_random_uuid(),id,'describe_image','failed','synthetic-hash',2,2,now(),'Synthetic upstream 503' FROM "Image"`);
    await client.query(
      `INSERT INTO "ImageProcessingSubmission" (id) VALUES (gen_random_uuid())`,
    );
    await client.query(`INSERT INTO "ImageProcessingSubmissionJob" (id,"submissionId","jobId",disposition,"baselineAttempts")
      SELECT gen_random_uuid(),s.id,j.id,'new',0 FROM "ImageProcessingSubmission" s CROSS JOIN "ImageProcessingJob" j`);
    await client.query(`INSERT INTO "ImageProcessingAttempt" (id,"jobId",number,state,error,diagnostics)
      SELECT gen_random_uuid(),id,1,CASE WHEN state = 'leased' THEN 'leased' ELSE 'failed' END,"lastError",'{"synthetic":true}' FROM "ImageProcessingJob"`);
    await client.query(`INSERT INTO "ImageProcessingEvent" (id,"jobId","eventKey",attempt,event,details)
      SELECT gen_random_uuid(),id,'synthetic-claim',1,'synthetic.step.01','{"synthetic":true}' FROM "ImageProcessingJob"`);

    const work = async () =>
      (
        await client.query(`SELECT j.id,j.kind,j.state,j."attemptId",j."leaseExpiresAt",j.attempts,j."lastError",
          (SELECT count(*)::int FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id) AS "attemptRows",
          (SELECT count(*)::int FROM "ImageProcessingEvent" e WHERE e."jobId" = j.id) AS "eventRows",
          (SELECT count(*)::int FROM "ImageProcessingSubmissionJob" m WHERE m."jobId" = j.id) AS memberships
          FROM "ImageProcessingJob" j ORDER BY j.id`)
      ).rows;
    const before = await work();
    expect(before).toHaveLength(2);

    await migrateDatabase(drizzle(client));

    expect(await work()).toEqual(before);
    const identities = (
      await client.query(`SELECT j.shortcode, e.kind, e.shortcode AS "entityShortcode"
        FROM "ImageProcessingJob" j JOIN "Entity" e ON e.id = j.id ORDER BY j.id`)
    ).rows;
    expect(identities).toHaveLength(2);
    for (const identity of identities) {
      expect(identity.shortcode).toMatch(/^IPR-[23456789A-HJKMNP-Z]{5}$/u);
      expect(identity).toMatchObject({
        kind: "imageJob",
        entityShortcode: identity.shortcode,
      });
    }
    expect(new Set(identities.map((row) => row.shortcode)).size).toBe(2);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'ImageProcessingJob' AND column_name = 'publicId'`,
        )
      ).rows[0]?.count,
    ).toBe(0);

    // New work after the cutover gets its identity from the triggers.
    await client.query(`INSERT INTO "ImageProcessingJob" (id,shortcode,"imageId",kind,state,"sourceContentHash","processorRevision")
      SELECT gen_random_uuid(),'IPR-4K7M',id,'identify_image','pending','synthetic-hash',1 FROM "Image"`);
    expect(
      (
        await client.query(
          `SELECT kind FROM "Entity" WHERE shortcode = 'IPR-4K7M'`,
        )
      ).rows,
    ).toEqual([{ kind: "imageJob" }]);
  });
});
