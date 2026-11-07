import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Recovery may restore owed work, but cannot discard paid evidence or resume member stops.
it("recovers known background failures while preserving evidence, stops and live leases", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0116_adr25-l2f-image" });
    let sequence = 0;
    const nextId = () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('synthetic-background-recovery','Synthetic member','background-recovery@example.test')`,
    );
    const owners = new Map<string, string>();
    for (const status of [
      "running",
      "paused",
      "needs_review",
      "failed",
      "retired",
    ]) {
      const id = nextId();
      const code = `RUN-SYNBG${sequence}`;
      owners.set(status, id);
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Run" (id,shortcode,"actorName",trigger,purpose,"actorUserId","actorEmail",status,"retiredAt",input,progress)
         VALUES ($1,$2,'Synthetic member','manual','ai_refresh','synthetic-background-recovery','background-recovery@example.test',$3,$4,'{"retained":"source"}','{"retained":"checkpoint"}')`,
        [
          id,
          code,
          status === "retired" ? "running" : status,
          status === "retired" ? "2026-01-01" : null,
        ],
      );
    }
    const funding =
      "AI Gateway request failed: Decision request failed (402): Synthetic TypeSafe API credits unavailable";
    const eligibility =
      "Connection Expense is no longer eligible for acquisition or is already assigned to a Product";
    const pairEligibility =
      "Connection Product/Purchase pair is no longer eligible because acquisition is already recorded";
    const targets = new Map<string, string>();
    const evaluation = async (
      key: string,
      fields: {
        state?: string;
        slot?: string;
        owner?: string;
        error?: string;
        paid?: boolean;
        lease?: "live" | "expired";
        future?: boolean;
        createdAt?: string;
        cancelledRequest?: boolean;
      } = {},
    ) => {
      const id = nextId();
      const slot = fields.slot ?? key;
      let targetId = targets.get(slot);
      if (!targetId) {
        targetId = nextId();
        targets.set(slot, targetId);
      }
      await client.query(
        `INSERT INTO "AiEvaluation" (id,"runId","workKey",feature,target,provenance,snapshot,state,result,receipt,error,"runAt",attempts,"leaseToken","leaseUntil","leaseStale","waitCause","createdAt")
         VALUES ($1::uuid,$2,$4,'entity-connections',jsonb_build_object('kind','product','entity','product','recordId',$3::text),'{"dependencies":[{"key":"synthetic","generation":7}],"inputFingerprint":"retained"}','{"source":"retained evidence"}',$5,$6::jsonb,'{"retained":"receipt"}',$7,$8,3,$9,$10,true,'provider_capacity',$11)`,
        [
          id,
          fields.owner ? owners.get(fields.owner) : null,
          targetId,
          key,
          fields.state ?? "failed",
          fields.paid
            ? JSON.stringify({ paid: "Synthetic retained answer" })
            : null,
          fields.error ?? funding,
          fields.future ? "2099-01-01" : "2026-01-01",
          fields.lease ? nextId() : null,
          fields.lease === "live"
            ? "2099-01-01"
            : fields.lease === "expired"
              ? "2026-01-01"
              : null,
          fields.createdAt ?? "2026-01-01",
        ],
      );
      if (fields.owner)
        await client.query(
          `INSERT INTO "AiEvaluationRequest" ("runId","evaluationId","cancelledAt",receipt)
           VALUES ($1,$2,$3,'{"retained":"member request receipt"}')`,
          [
            owners.get(fields.owner),
            id,
            fields.cancelledRequest ? "2026-01-01" : null,
          ],
        );
    };
    await evaluation("completed", {
      state: "completed",
      paid: true,
      lease: "expired",
    });
    await evaluation("obsolete", { state: "obsolete", paid: true });
    await evaluation("terminal-live", {
      state: "completed",
      paid: true,
      lease: "live",
    });
    await evaluation("eligibility", { error: eligibility, paid: true });
    await evaluation("pair-eligibility", {
      error: pairEligibility,
      lease: "expired",
    });
    await evaluation("eligibility-live", { error: eligibility, lease: "live" });
    await evaluation("funding-paid", { paid: true });
    await evaluation("funding-unpaid");
    await evaluation("funding-future", { future: true });
    await evaluation("funding-owned", { owner: "running", paid: true });
    await evaluation("funding-old", {
      slot: "shared-history",
      createdAt: "2026-01-01",
    });
    await evaluation("funding-latest", {
      slot: "shared-history",
      createdAt: "2026-02-01",
    });
    await evaluation("funding-with-successor", { slot: "pending-successor" });
    await evaluation("successor", {
      slot: "pending-successor",
      state: "queued",
      error: "Synthetic unrelated source",
      createdAt: "2026-02-01",
    });
    await evaluation("funding-live", { lease: "live", paid: true });
    await evaluation("funding-cancelled", {
      owner: "running",
      cancelledRequest: true,
    });
    for (const owner of ["paused", "needs_review", "failed", "retired"])
      await evaluation(`funding-${owner}`, { owner, paid: true });
    await evaluation("cancelled", { state: "cancelled", paid: true });
    await evaluation("unrelated", {
      error: "Synthetic unrelated validation failure",
    });

    const imageId = nextId();
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'image','IMG-SYNBGRECOVERY')`,
      [imageId],
    );
    await client.query(
      `INSERT INTO "Image" (id,shortcode,key,filename,size,"contentType",status,sha256)
       VALUES ($1,'IMG-SYNBGRECOVERY','synthetic/background-recovery','synthetic.jpg',100,'image/jpeg','UPLOADED',$2)`,
      [imageId, "a".repeat(64)],
    );
    const imageCases = [
      { key: "deterministic", retryable: false, lease: null, completed: null },
      {
        key: "deterministic-expired",
        retryable: false,
        lease: "2026-01-01",
        completed: "2026-01-02",
      },
      {
        key: "deterministic-live",
        retryable: false,
        lease: "2099-01-01",
        completed: null,
      },
      { key: "retryable", retryable: true, lease: null, completed: null },
      { key: "unsupported", retryable: true, lease: null, completed: null },
    ];
    for (const entry of imageCases) {
      const id = nextId();
      const code = `IPR-SYNBG${sequence}`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'imageJob',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "ImageProcessingJob" (id,shortcode,"imageId",kind,state,lane,"sourceContentHash","processorRevision",attempts,failures,"lastError",result,"leaseUntil","waitReason","completedAt","updatedAt")
         VALUES ($1,$2,$3,'subject_lift','pending','device',$4,$5,4,2,$6,$7::jsonb,$8,'device',$9,'2026-01-03')`,
        [
          id,
          code,
          imageId,
          "a".repeat(64),
          sequence,
          entry.key,
          JSON.stringify({
            status: "failed",
            retryable: entry.retryable,
            reason:
              entry.key === "unsupported"
                ? "unsupported_format"
                : "Synthetic refusal",
            error: "Synthetic retained device refusal",
            evidence: { source: "retained" },
          }),
          entry.lease,
          entry.completed,
        ],
      );
    }
    const evaluations = async () =>
      new Map(
        (
          await client.query<{ key: string; value: unknown }>(
            `SELECT "workKey" AS key,to_jsonb(e) AS value FROM "AiEvaluation" e ORDER BY "workKey"`,
          )
        ).rows.map(({ key, value }) => [key, value]),
      );
    const evaluationEvidence = async () =>
      (
        await client.query(
          `SELECT "workKey",target,provenance,snapshot,result,receipt,error,"runId","shareKey",priority,"executionKind","createdAt","updatedAt" FROM "AiEvaluation" ORDER BY "workKey"`,
        )
      ).rows;
    const images = async () =>
      new Map(
        (
          await client.query<{ key: string; value: unknown }>(
            `SELECT "lastError" AS key,to_jsonb(j) AS value FROM "ImageProcessingJob" j ORDER BY "lastError"`,
          )
        ).rows.map(({ key, value }) => [key, value]),
      );
    const imageEvidence = async () =>
      (
        await client.query(
          `SELECT id,"imageId",kind,lane,"sourceContentHash","processorRevision",attempts,failures,result,"lastError","runAt","updatedAt" FROM "ImageProcessingJob" ORDER BY id`,
        )
      ).rows;
    const ownersBefore = (await client.query(`SELECT * FROM "Run" ORDER BY id`))
      .rows;
    const requestsBefore = (
      await client.query(`SELECT * FROM "AiEvaluationRequest" ORDER BY id`)
    ).rows;
    const evidenceBefore = await evaluationEvidence();
    const imageEvidenceBefore = await imageEvidence();
    const before = await evaluations();
    const imagesBefore = await images();
    await migrateDatabase(db, { through: "0117_background-work-recovery" });
    const after = await evaluations();
    const imagesAfter = await images();
    expect(await evaluationEvidence()).toEqual(evidenceBefore);
    expect(await imageEvidence()).toEqual(imageEvidenceBefore);
    expect(
      (await client.query(`SELECT * FROM "Run" ORDER BY id`)).rows,
    ).toEqual(ownersBefore);
    expect(
      (await client.query(`SELECT * FROM "AiEvaluationRequest" ORDER BY id`))
        .rows,
    ).toEqual(requestsBefore);
    for (const key of [
      "completed",
      "obsolete",
      "eligibility",
      "pair-eligibility",
    ])
      expect(after.get(key)).toMatchObject({
        state: key === "completed" ? "completed" : "obsolete",
        runAt: null,
        leaseToken: null,
        leaseUntil: null,
        leaseStale: false,
        waitCause: null,
        attempts: 3,
      });
    for (const key of ["funding-paid", "funding-owned"])
      expect(after.get(key)).toMatchObject({
        state: "result_ready",
        attempts: 0,
        leaseToken: null,
        leaseUntil: null,
        leaseStale: false,
        waitCause: "provider_capacity",
      });
    for (const key of ["funding-unpaid", "funding-future", "funding-latest"])
      expect(after.get(key)).toMatchObject({
        state: "queued",
        attempts: 0,
        leaseToken: null,
        leaseUntil: null,
        leaseStale: false,
        waitCause: "provider_capacity",
      });
    expect(
      (
        await client.query(
          `SELECT bool_and("runAt" BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes') AS delayed FROM "AiEvaluation" WHERE "workKey" IN ('funding-paid','funding-owned','funding-unpaid','funding-latest')`,
        )
      ).rows,
    ).toEqual([{ delayed: true }]);
    expect(
      (
        await client.query(
          `SELECT "runAt" = '2099-01-01'::timestamp AS retained FROM "AiEvaluation" WHERE "workKey" = 'funding-future'`,
        )
      ).rows,
    ).toEqual([{ retained: true }]);
    for (const key of [
      "terminal-live",
      "eligibility-live",
      "funding-old",
      "funding-with-successor",
      "successor",
      "funding-live",
      "funding-cancelled",
      "funding-paused",
      "funding-needs_review",
      "funding-failed",
      "funding-retired",
      "cancelled",
      "unrelated",
    ])
      expect({ key, row: after.get(key) }).toEqual({
        key,
        row: before.get(key),
      });
    for (const key of ["deterministic", "deterministic-expired", "unsupported"])
      expect(imagesAfter.get(key)).toMatchObject({
        state: "failed",
        leaseUntil: null,
        waitReason: null,
        attempts: 4,
      });
    expect(
      (
        await client.query(
          `SELECT "lastError","completedAt" = CASE WHEN "lastError"='deterministic' THEN '2026-01-03'::timestamp ELSE '2026-01-02'::timestamp END AS retained FROM "ImageProcessingJob" WHERE "lastError" IN ('deterministic','deterministic-expired') ORDER BY "lastError"`,
        )
      ).rows,
    ).toEqual([
      { lastError: "deterministic", retained: true },
      { lastError: "deterministic-expired", retained: true },
    ]);
    for (const key of ["deterministic-live", "retryable"])
      expect({ key, row: imagesAfter.get(key) }).toEqual({
        key,
        row: imagesBefore.get(key),
      });
  });
});
