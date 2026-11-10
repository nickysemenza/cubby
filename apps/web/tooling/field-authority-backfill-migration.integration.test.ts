import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Failure mode: the backfill stamps a member's write as Cubby's, so a later
// re-evaluation overwrites a person's value, or misses Cubby's own write.
it("stamps exactly the audit rows an automatic field receipt lists and retires subject-product guesses", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client: client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261110021115_drop_run_approval",
    });
    const product = "00000000-0000-4000-8000-000000000a01";
    const task = "00000000-0000-4000-8000-000000000a02";
    const automaticAudit = "00000000-0000-4000-8000-000000000a11";
    const memberAudit = "00000000-0000-4000-8000-000000000a12";
    const memberReceiptAudit = "00000000-0000-4000-8000-000000000a13";
    await client.query(
      `INSERT INTO "Entity" (id,kind,shortcode) VALUES ($1,'product','PRD-SYNTHAUTH'),($2,'task','TSK-SYNTHAUTH')`,
      [product, task],
    );
    await client.query(
      `INSERT INTO "Product" (id,shortcode,name) VALUES ($1,'PRD-SYNTHAUTH','Synthetic authority product')`,
      [product],
    );
    await client.query(
      `INSERT INTO "AuditLog" (id,"entityKind","entityId",action,changes,"userId",channel,"createdAt") VALUES
        ($1,'product',$4,'update','{"categoryId":{"from":null,"to":"synthetic-a"}}','cubby-system','system','2026-01-01T10:00:00Z'),
        ($2,'product',$4,'update','{"categoryId":{"from":"synthetic-a","to":"synthetic-b"}}','cubby-system','web','2026-01-01T11:00:00Z'),
        ($3,'product',$4,'update','{"brandId":{"from":null,"to":"synthetic-brand"}}','cubby-system','web','2026-01-01T12:00:00Z')`,
      [automaticAudit, memberAudit, memberReceiptAudit, product],
    );
    const receipt = (mode: string, auditIds: string[]) =>
      JSON.stringify({ mode, auditIds, acceptedAt: "2026-01-01T10:00:00Z" });
    await client.query(
      `INSERT INTO "Suggestion" ("publicationKey",family,subject,judgment,entity,"recordId",field,status,"acceptanceReceipt") VALUES
        ('synthetic-automatic','field','{}','{}','product',$1,'categoryId','applied',$2::jsonb),
        ('synthetic-member','field','{}','{}','product',$1,'brandId','applied',$3::jsonb),
        ('synthetic-subject','field','{}','{}','task',$4,'subjectProductId','pending',NULL),
        ('synthetic-subject-decided','field','{}','{}','task',$4,'subjectProductId','rejected',NULL)`,
      [
        product,
        receipt("automatic", [automaticAudit]),
        receipt("member", [memberReceiptAudit]),
        task,
      ],
    );
    await migrateDatabase(db, {
      through: "20261110042454_cubby_acts_first",
    });
    expect(
      (
        await client.query(
          `SELECT id::text, authority, "automationPending" FROM "AuditLog" WHERE "entityId" = $1 ORDER BY "createdAt"`,
          [product],
        )
      ).rows,
    ).toEqual([
      { id: automaticAudit, authority: "automatic", automationPending: false },
      { id: memberAudit, authority: null, automationPending: false },
      { id: memberReceiptAudit, authority: null, automationPending: false },
    ]);
    expect(
      (
        await client.query(
          `SELECT "publicationKey", status, active FROM "Suggestion" WHERE entity = 'task' ORDER BY "publicationKey"`,
        )
      ).rows,
    ).toEqual([
      {
        publicationKey: "synthetic-subject",
        status: "superseded",
        active: false,
      },
      {
        publicationKey: "synthetic-subject-decided",
        status: "rejected",
        active: true,
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT to_regclass('"AutomaticRule"') IS NULL AS dropped`,
        )
      ).rows,
    ).toEqual([{ dropped: true }]);
  });
});
