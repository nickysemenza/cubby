import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("preserves retained publications and input identities across precise fanout migrations", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0059_sender_attribution_policies" });
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product','PRD-SYNTHETIC')`,
      [id],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name) VALUES ($1,'PRD-SYNTHETIC','Synthetic retained product')`,
      [id],
    );
    await client.query(
      `INSERT INTO "DerivedValue" ("entityId",kind,key,value,"computedAt") VALUES ($1,'product','readFacts','{"retained":"synthetic"}',now())`,
      [id],
    );
    await client.query(
      `SELECT derived_mark('product.readFacts@44', ARRAY[$1::uuid])`,
      [id],
    );
    const preserved = async () => ({
      work: (
        await client.query(
          `SELECT to_jsonb(w) value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
      publications: (
        await client.query(
          `SELECT to_jsonb(v) value FROM "DerivedValue" v ORDER BY "entityId",key`,
        )
      ).rows,
      products: (
        await client.query(
          `SELECT to_jsonb(p) value FROM "Product" p ORDER BY id`,
        )
      ).rows,
    });
    const before = await preserved();
    await migrateDatabase(db, { through: "0060_precise_location_fanout" });
    expect(await preserved()).toEqual(before);
    // A deleted SourceOrder can leave its UUID ticket owed to the predecessor expansion.
    await client.query(
      `SELECT derived_mark('email.relationshipFacts@8', ARRAY[$1::uuid])`,
      [id],
    );
    await client.query(
      `UPDATE "WorkItem" SET priority=2, attempts=1, "readyAt"=now()+interval '1 day' WHERE target='email.relationshipFacts@8'`,
    );
    const beforeSourceOrder = await preserved();
    await migrateDatabase(db, { through: "0061_source_order_purchase_fanout" });
    expect(await preserved()).toEqual(beforeSourceOrder);
    const definition = (
      await client.query(
        `SELECT pg_get_functiondef('derived_mark_importsourceorder()'::regprocedure) AS value`,
      )
    ).rows[0]?.value;
    expect(definition).toContain("derived_mark('email.relationshipFacts@9'");
    expect(definition).not.toContain(
      "derived_mark('email.relationshipFacts@8'",
    );
    // A retired Claim can still have broad predecessor work with retained backoff.
    await client.query(
      `SELECT derived_mark('email.relationshipFacts@7', ARRAY[$1::uuid])`,
      [id],
    );
    await client.query(
      `UPDATE "WorkItem" SET priority=2, attempts=2, "readyAt"=now()+interval '2 days' WHERE target='email.relationshipFacts@7'`,
    );
    const beforeSourceClaim = await preserved();
    await migrateDatabase(db, { through: "0062_source_claim_family_fanout" });
    expect(await preserved()).toEqual(beforeSourceClaim);
    const claimDefinition = (
      await client.query(
        `SELECT pg_get_functiondef('derived_mark_importsourceclaim()'::regprocedure) AS value`,
      )
    ).rows[0]?.value;
    expect(claimDefinition).not.toContain(
      "derived_mark('email.relationshipFacts@7'",
    );
    expect(claimDefinition).toContain(
      "derived_mark('email.relationshipFacts@10'",
    );
    expect(claimDefinition).toContain(
      "derived_mark('email.relationshipFacts@11'",
    );
    await migrateDatabase(db, { through: "0063_shipment_tracking_identity" });
    const beforeObservation = await preserved();
    await migrateDatabase(db, {
      through: "0064_derived_execution_observation",
    });
    const afterObservation = await preserved();
    const retainedWork = await client.query(
      `SELECT to_jsonb(w) - 'executionLeaseToken' - 'executionTicket' - 'executionStartedAt' AS value
       FROM "WorkItem" w ORDER BY target,ref`,
    );
    expect(retainedWork.rows).toEqual(beforeObservation.work);
    expect(afterObservation.publications).toEqual(
      beforeObservation.publications,
    );
    expect(afterObservation.products).toEqual(beforeObservation.products);
    const observations = await client.query(
      `SELECT count(*)::int AS count FROM "WorkItem"
       WHERE "executionLeaseToken" IS NOT NULL OR "executionTicket" IS NOT NULL OR "executionStartedAt" IS NOT NULL`,
    );
    expect(observations.rows[0]?.count).toBe(0);
    await client.query(
      `INSERT INTO "Assessment" ("publicationKey",family,subject,judgment,evidence)
       VALUES ('synthetic-index-upgrade','recommendation','{"scope":"connection.synthetic"}','{}',
         jsonb_build_object('candidate',jsonb_build_object('source',jsonb_build_object('entityKind','product','entityId',$1::text)),
           'records',jsonb_build_array(jsonb_build_object('entity','product','id',$1::text))))`,
      [id],
    );
    const beforeIndexes = await preserved();
    const history = await client.query(
      `SELECT to_jsonb(a) value FROM "Assessment" a ORDER BY id`,
    );
    await migrateDatabase(db, {
      through: "0066_assessment_refresh_metadata",
    });
    const afterRefreshMetadata = await preserved();
    expect(
      (
        await client.query(
          `SELECT to_jsonb(w) - 'reason' AS value FROM "WorkItem" w ORDER BY target,ref`,
        )
      ).rows,
    ).toEqual(beforeIndexes.work);
    expect(afterRefreshMetadata.publications).toEqual(
      beforeIndexes.publications,
    );
    expect(afterRefreshMetadata.products).toEqual(beforeIndexes.products);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "WorkItem" WHERE reason IS NOT NULL`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await client.query(
          `SELECT to_jsonb(a) value FROM "Assessment" a ORDER BY id`,
        )
      ).rows,
    ).toEqual(history.rows);
    const indexes = await client.query(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public'
       AND indexname IN ('Assessment_connection_source_ref_idx','Assessment_connection_target_ref_idx','Assessment_reference_records_idx')`,
    );
    expect(indexes.rows[0]?.count).toBe(3);
    await client.query(
      `SELECT derived_mark('product.readFacts', ARRAY[$1::uuid])`,
      [id],
    );
    expect(
      (
        await client.query(
          `SELECT reason FROM "WorkItem" WHERE target='product.readFacts' AND ref=$1`,
          [id],
        )
      ).rows[0]?.reason,
    ).toBe("Refresh requested");
    await client.query(
      `UPDATE "Product" SET name='Synthetic changed product' WHERE id=$1`,
      [id],
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "WorkItem" WHERE ref=$1 AND reason='Product changed'`,
          [id],
        )
      ).rows[0]?.count,
    ).toBeGreaterThan(0);
  });
});
