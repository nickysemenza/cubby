import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves nullable signed stated totals and refuses noisy originals transactionally", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0103_drop_workitem_capture_evidence",
    });
    const vendor = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'vendor','VEN-SYNTOTAL')`,
      [vendor],
    );
    await client.query(
      `INSERT INTO "Vendor" (id,shortcode,name) VALUES ($1,'VEN-SYNTOTAL','Synthetic vendor')`,
      [vendor],
    );
    for (const [i, amount] of [10.01, -0.01, 0, null].entries()) {
      const id = `00000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`;
      const code = `PUR-SYNTOTAL${i}`;
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'purchase',$2)`,
        [id, code],
      );
      await client.query(
        `INSERT INTO "Purchase" (id,shortcode,"vendorId","statedTotal") VALUES ($1,$2,$3,$4)`,
        [id, code, vendor, amount],
      );
    }
    const run = "00000000-0000-4000-8000-000000000999";
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('total-member','Synthetic member','total@example.test')`,
    );
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'run','RUN-SYNTOTAL')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status) VALUES ($1,'RUN-SYNTOTAL','Synthetic member','manual','total-member','total@example.test','sweep','running')`,
      [run],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state) VALUES ($1,'statement_generate','Synthetic refresh',0,'running')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('total-refresh','run.execute','queued',$1,'{}')`,
      [run],
    );
    await expect(
      migrateDatabase(db, { through: "0104_purchase_total_minor_units" }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Run" SET status='failed',"failureCode"='user_cancelled',"endedAt"=now() WHERE id=$1`,
      [run],
    );
    await expect(
      migrateDatabase(db, { through: "0104_purchase_total_minor_units" }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='total-refresh'`,
    );
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(p) ORDER BY id) AS rows FROM "Purchase" p`,
      )
    ).rows[0].rows;
    await client.query(
      `UPDATE "Purchase" SET "statedTotal"=10.010000000000002 WHERE shortcode='PUR-SYNTOTAL0'`,
    );
    await expect(
      migrateDatabase(db, { through: "0104_purchase_total_minor_units" }),
    ).rejects.toThrow("independent IEEE");
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."Purchase_dollar_preimage"') AS archived`,
        )
      ).rows[0].archived,
    ).toBeNull();
    await client.query(
      `UPDATE "Purchase" SET "statedTotal"=10.01 WHERE shortcode='PUR-SYNTOTAL0'`,
    );
    await migrateDatabase(db, { through: "0104_purchase_total_minor_units" });
    expect(
      (
        await client.query(
          `SELECT "statedTotalMinor"::text AS minor FROM "Purchase" ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { minor: "1001" },
      { minor: "-1" },
      { minor: "0" },
      { minor: null },
    ]);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg((to_jsonb(p)-'statedTotalMinor')||jsonb_build_object('statedTotal',"statedTotalMinor"::numeric/100) ORDER BY id) AS rows FROM "Purchase" p`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(p) ORDER BY id) AS rows FROM archive."Purchase_dollar_preimage" p`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    await expect(
      client.query(`UPDATE "Purchase" SET "statedTotal"=1`),
    ).rejects.toThrow('column "statedTotal"');
  });
});
