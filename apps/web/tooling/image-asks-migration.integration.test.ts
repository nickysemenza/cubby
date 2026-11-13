import { generateShortcode } from "@cubby/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves image receipts and results, queues unsent work, and never queues a sent outcome", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113080036_kernel_pass_wakes",
    });
    const images = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const imageCodes = images.map(() => generateShortcode("image")),
      jobCodes = images.map(() => generateShortcode("imageJob"));
    const jobs = images.map(() => crypto.randomUUID());
    const tokens = images.map(() => crypto.randomUUID());
    const result = {
      kind: "subject_lift",
      status: "skipped",
      reason: "no_subject",
    };
    for (let index = 0; index < images.length; index++) {
      const id = images[index];
      const job = jobs[index];
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'image',$2),($3,'imageJob',$4)`,
        [id, imageCodes[index], job, jobCodes[index]],
      );
      await client.query(
        `INSERT INTO "Image" (id,shortcode,key,filename,size,"contentType",status,sha256) VALUES ($1,$2,$3,'synthetic.png',512,'image/png','UPLOADED',$4)`,
        [id, imageCodes[index], `synthetic/${id}.png`, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO "ImageProcessingJob" (id,shortcode,"imageId",kind,state,"sourceContentHash","processorRevision",lane,attempts,"attemptId","leaseUntil") VALUES ($1,$2,$3,'subject_lift',$4,$5,1,'device',$6,$7,$8)`,
        [
          job,
          jobCodes[index],
          id,
          index === 2 ? "skipped" : "pending",
          "a".repeat(64),
          index === 0 ? 0 : 1,
          index === 0 ? null : tokens[index],
          index === 1 ? new Date(Date.now() + 60000) : null,
        ],
      );
      if (index > 0)
        await client.query(
          `INSERT INTO "ImageProcessingAttempt" (id,"jobId",number,state,executor,result,"completedAt") VALUES ($1,$2,1,$3,$4,$5,$6)`,
          [
            tokens[index],
            job,
            index === 2 ? "skipped" : "running",
            JSON.stringify({
              kind: "device",
              deviceId: images[0],
              name: "Synthetic device",
              platform: "macos",
              appVersion: "1",
              osVersion: "1",
            }),
            index === 2 ? JSON.stringify(result) : null,
            index === 2 ? new Date() : null,
          ],
        );
      if (index < 2)
        await client.query(
          `INSERT INTO "SearchDocument" ("entityKind","entityId",title,body,"semanticText","normalizedText","searchVector","sourceHash","embeddingDueAt","embeddingLeaseToken") VALUES ('image',$1,'Synthetic image','synthetic','synthetic','synthetic',to_tsvector('simple','synthetic'),$2,now(),$3)`,
          [
            id,
            `synthetic-revision-${index}`,
            index === 1 ? tokens[index] : null,
          ],
        );
    }
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(i) ORDER BY id) AS rows FROM "Image" i`,
      )
    ).rows[0].rows;
    await migrateDatabase(db, {
      through: "20261113105727_embedding-image-asks",
    });
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(i) ORDER BY id) AS rows FROM "Image" i`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    const queued = await client.query(
      `SELECT state,"claimToken" FROM "Ask" WHERE id=$1`,
      [jobs[0]],
    );
    expect(queued.rows).toEqual([{ state: "queued", claimToken: null }]);
    const unknown = await client.query(
      `SELECT state,"claimToken" FROM "Ask" WHERE id=$1`,
      [jobs[1]],
    );
    expect(unknown.rows).toEqual([{ state: "unknown", claimToken: tokens[1] }]);
    expect(
      (
        await client.query(
          `SELECT "askId",output->>'jobId' AS "jobId",output->'outcome' AS result FROM "Answer" WHERE "claimToken"=$1`,
          [tokens[2]],
        )
      ).rows,
    ).toEqual([{ askId: jobs[2], jobId: jobs[2], result }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM "ImageProcessingEvent" WHERE event='execution.receipt'`,
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    expect(
      (
        await client.query(
          `SELECT state FROM "Ask" WHERE feature='entity.embedding' ORDER BY input->'input'->>'sourceHash'`,
        )
      ).rows,
    ).toEqual([{ state: "queued" }, { state: "queued" }]);
    expect(
      (
        await client.query(
          `SELECT to_regclass('"ImageProcessingAttempt"') AS old`,
        )
      ).rows,
    ).toEqual([{ old: null }]);
  });
});
