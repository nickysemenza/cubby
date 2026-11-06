import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Receipt evidence can be negative or zero. Convert its exact value without changing source ownership.
it("preserves signed receipt amounts and source relationships while refusing unproven cents", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0098_source_occurrence_ownership" });
    const ids = [1, 2, 3, 4, 5].map(
      (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    const [run, party, vendor, purchase, claim] = ids;
    await client.query(
      `INSERT INTO "user" (id,name,email) VALUES ('payment-migration','Synthetic member','payment@example.test')`,
    );
    for (const [id, kind, shortcode] of [
      [run, "run", "RUN-SYNPAYMENT"],
      [party, "ledgerParty", "LPY-SYNPAYMENT"],
      [vendor, "vendor", "VEN-SYNPAYMENT"],
      [purchase, "purchase", "PUR-SYNPAYMENT"],
    ])
      await client.query(
        `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,$2,$3)`,
        [id, kind, shortcode],
      );
    await client.query(
      `INSERT INTO "Run" (id,shortcode,"actorName",trigger,"actorUserId","actorEmail",purpose,status,"endedAt") VALUES ($1,'RUN-SYNPAYMENT','Synthetic member','manual','payment-migration','payment@example.test','sweep','completed',now())`,
      [run],
    );
    await client.query(
      `INSERT INTO "LedgerParty" (id,shortcode,name,kind) VALUES ($1,'LPY-SYNPAYMENT','Synthetic party','guest')`,
      [party],
    );
    await client.query(
      `INSERT INTO "Vendor" (id,shortcode,name) VALUES ($1,'VEN-SYNPAYMENT','Synthetic vendor')`,
      [vendor],
    );
    await client.query(
      `INSERT INTO "Purchase" (id,shortcode,"vendorId") VALUES ($1,'PUR-SYNPAYMENT',$2)`,
      [purchase, vendor],
    );
    await client.query(
      `INSERT INTO "ImportSourceClaim" (id,"ledgerPartyId",kind,"externalKey",checksum,"firstRunId","lastRunId") VALUES ($1,$2,'vendor_export','synthetic-payment','synthetic-checksum',$3,$3)`,
      [claim, party, run],
    );
    for (const [index, amount] of [10.01, -0.01, 0].entries())
      await client.query(
        `INSERT INTO "PurchasePaymentEvidence" ("purchaseId","sourceClaimId",amount,"evidenceIndex",tender,description) VALUES ($1,$2,$3,$4,'card','Original synthetic receipt')`,
        [purchase, claim, amount, index],
      );
    const before = (
      await client.query(
        `SELECT jsonb_agg(to_jsonb(r) ORDER BY "evidenceIndex") AS rows FROM "PurchasePaymentEvidence" r`,
      )
    ).rows[0].rows;
    await client.query(
      `UPDATE "Run" SET status='running',"endedAt"=NULL WHERE id=$1`,
      [run],
    );
    await client.query(
      `INSERT INTO "RunStep" ("runId",key,label,position,state) VALUES ($1,'statement_generate','Synthetic retained scan',0,'running')`,
      [run],
    );
    await client.query(
      `INSERT INTO "Job" (key,kind,state,"runId",input) VALUES ('synthetic-payment-cancel','run.execute','queued',$1,'{}')`,
      [run],
    );
    await expect(
      migrateDatabase(db, { through: "0100_payment_evidence_minor_units" }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Run" SET status='failed',"failureCode"='user_cancelled',"endedAt"=now() WHERE id=$1`,
      [run],
    );
    await expect(
      migrateDatabase(db, { through: "0100_payment_evidence_minor_units" }),
    ).rejects.toThrow("Financial refresh has unfinished steps");
    await client.query(
      `UPDATE "Job" SET state='cancelled' WHERE key='synthetic-payment-cancel'`,
    );
    await client.query(
      `UPDATE "PurchasePaymentEvidence" SET amount=10.010000000000002 WHERE "evidenceIndex"=0`,
    );
    await expect(
      migrateDatabase(db, { through: "0100_payment_evidence_minor_units" }),
    ).rejects.toThrow("independent IEEE");
    expect(
      (
        await client.query(
          `SELECT to_regclass('archive."PurchasePaymentEvidence_dollar_preimage"') AS archived`,
        )
      ).rows[0].archived,
    ).toBeNull();
    await client.query(
      `UPDATE "PurchasePaymentEvidence" SET amount=10.01 WHERE "evidenceIndex"=0`,
    );
    await migrateDatabase(db, { through: "0100_payment_evidence_minor_units" });
    expect(
      (
        await client.query(
          `SELECT "amountMinor"::text AS minor FROM "PurchasePaymentEvidence" ORDER BY "evidenceIndex"`,
        )
      ).rows,
    ).toEqual([{ minor: "1001" }, { minor: "-1" }, { minor: "0" }]);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg((to_jsonb(r)-'amountMinor')||jsonb_build_object('amount',"amountMinor"::numeric/100) ORDER BY "evidenceIndex") AS rows FROM "PurchasePaymentEvidence" r`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT jsonb_agg(to_jsonb(r) ORDER BY "evidenceIndex") AS rows FROM archive."PurchasePaymentEvidence_dollar_preimage" r`,
        )
      ).rows[0].rows,
    ).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM "PurchasePaymentEvidence" p JOIN "Purchase" target ON target.id=p."purchaseId" JOIN "ImportSourceClaim" source ON source.id=p."sourceClaimId"`,
        )
      ).rows[0].n,
    ).toBe(3);
    await expect(
      client.query(`UPDATE "PurchasePaymentEvidence" SET amount=1`),
    ).rejects.toThrow('column "amount"');
  });
});
