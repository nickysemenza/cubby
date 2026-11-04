import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("indexes long retained source references without changing evidence or unfinished work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0067_foreign_receipt_coverage" });
    const id = "00000000-0000-4000-8000-000000000101";
    const longText = Array.from({ length: 512 }, (_, index) =>
      createHash("sha256")
        .update(`Synthetic retained identity ${index}`)
        .digest("hex"),
    ).join("");
    await client.query(
      `INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence)
       VALUES ($1,'synthetic-long-source','statement_transaction','{}',$2::jsonb,'{"retained":"Synthetic evidence"}')`,
      [
        id,
        JSON.stringify({
          create: { sourceRef: { source: longText, externalId: longText } },
        }),
      ],
    );
    await client.query(
      `INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority)
       VALUES ($1,'synthetic-retained-receipt','ungraded','{"present":false}','history','system')`,
      [id],
    );
    await client.query(
      `INSERT INTO "WorkItem" (target,ref,attempts,"lastError","readyAt")
       VALUES ('synthetic.retained',$1,2,'Synthetic retained retry',now()+interval '1 hour')`,
      [id],
    );
    const retained = async () => ({
      assessments: (
        await client.query(
          `SELECT to_jsonb(a) AS value FROM "Assessment" a ORDER BY id`,
        )
      ).rows,
      feedback: (
        await client.query(
          `SELECT to_jsonb(f) AS value FROM "Feedback" f ORDER BY id`,
        )
      ).rows,
      work: (
        await client.query(
          `SELECT to_jsonb(w) - 'waitCause' - 'waitStartedAt' AS value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
    });
    const before = await retained();
    await migrateDatabase(db, {
      through: "0068_assessment_settlement_source_index",
    });
    expect(await retained()).toEqual(before);
    expect(
      (
        await client.query(`SELECT i.indisready,i.indisvalid FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='Assessment_served_source_ref_idx'`)
      ).rows,
    ).toEqual([{ indisready: true, indisvalid: true }]);
    await client.query(
      `INSERT INTO "Assessment" ("publicationKey",family,subject,judgment)
       VALUES ('synthetic-long-source-after','field','{}',$1::jsonb)`,
      [
        JSON.stringify({
          create: {
            sourceRef: { source: `${longText}a`, externalId: `${longText}b` },
          },
        }),
      ],
    );
    const beforeWaits = await retained();
    await migrateDatabase(db, { through: "0069_work_item_coverage_waits" });
    expect(await retained()).toEqual(beforeWaits);
    expect(
      (
        await client.query(
          `SELECT "waitCause", "waitStartedAt" FROM "WorkItem" WHERE target='synthetic.retained' AND ref=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ waitCause: null, waitStartedAt: null }]);
    await expect(
      client.query(
        `UPDATE "WorkItem" SET "waitStartedAt"=now() WHERE target='synthetic.retained' AND ref=$1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      `UPDATE "WorkItem" SET "waitCause"='search_coverage', "waitStartedAt"=now() WHERE target='synthetic.retained' AND ref=$1`,
      [id],
    );
    await client.query(
      `SELECT derived_mark('synthetic.retained', ARRAY[$1::uuid], 'Synthetic fresh input')`,
      [id],
    );
    expect(
      (
        await client.query(
          `SELECT "waitCause", "waitStartedAt", attempts, "lastError" FROM "WorkItem" WHERE target='synthetic.retained' AND ref=$1`,
          [id],
        )
      ).rows,
    ).toEqual([
      { waitCause: null, waitStartedAt: null, attempts: 0, lastError: null },
    ]);
    await client.query(
      `SELECT derived_mark('product.searchDocument@6', ARRAY[$1::uuid], 'Synthetic retained image dependency')`,
      [id],
    );
    await client.query(
      `UPDATE "WorkItem" SET attempts=2,"lastError"='Synthetic retained failure',
       "readyAt"=now()+interval '1 day',"waitCause"='search_coverage',"waitStartedAt"=now()
       WHERE target='product.searchDocument@6' AND ref=$1`,
      [id],
    );
    const beforeCapture = await retained();
    const durableWork = async () => ({
      work: (
        await client.query(
          `SELECT to_jsonb(w) value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
      jobs: (
        await client.query(`SELECT to_jsonb(j) value FROM "Job" j ORDER BY id`)
      ).rows,
    });
    const beforeDurableWork = await durableWork();
    await migrateDatabase(db, {
      through: "0070_image_description_capture_scope",
    });
    expect(await retained()).toEqual(beforeCapture);
    expect(await durableWork()).toEqual(beforeDurableWork);
    await client.query(
      `UPDATE "Assessment" SET subject=jsonb_build_object('otherId',$2::text) WHERE id=$1`,
      [id, longText],
    );
    await client.query(
      `INSERT INTO "AssessmentState" (id,entity,"recordId","suggestedValue")
       VALUES ($1,'product',$1,$2::jsonb)`,
      [id, JSON.stringify(longText)],
    );
    const beforeMembership = await retained();
    const beforeMembershipWork = await durableWork();
    const states = async () =>
      (
        await client.query(
          `SELECT to_jsonb(s) value FROM "AssessmentState" s ORDER BY id`,
        )
      ).rows;
    const beforeStates = await states();
    await migrateDatabase(db, {
      through: "0071_assessment_existing_membership_indexes",
    });
    expect(await retained()).toEqual(beforeMembership);
    expect(await durableWork()).toEqual(beforeMembershipWork);
    expect(await states()).toEqual(beforeStates);
    expect(
      (
        await client.query(`SELECT c.relname,i.indisready,i.indisvalid FROM pg_index i
          JOIN pg_class c ON c.oid=i.indexrelid
          WHERE c.relname IN ('Assessment_served_other_id_idx','AssessmentState_active_value_status_idx')
          ORDER BY c.relname`)
      ).rows,
    ).toEqual([
      {
        relname: "AssessmentState_active_value_status_idx",
        indisready: true,
        indisvalid: true,
      },
      {
        relname: "Assessment_served_other_id_idx",
        indisready: true,
        indisvalid: true,
      },
    ]);
    await client.query(
      `UPDATE "AssessmentState" SET "suggestedValue"=$2::jsonb WHERE id=$1`,
      [id, JSON.stringify(`${longText} after index`)],
    );
  });
}, 90000);
