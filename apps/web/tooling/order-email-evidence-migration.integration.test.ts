import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import {
  seedCutoverPredecessor,
  cutoverId,
} from "./accepted-input-cutover.fixtures";
import { withMigrationDatabase } from "./test-database-lease";

// A second cutover must discover pre-existing evidence, carry member decisions,
// preserve every money row and retain the original accepted extraction.
it("adopts retained orders, Email decisions and transfers without changing money", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle({ client, paramsInErrors: true });
    await migrateDatabase(db, {
      through: "20261113113834_model_evaluation_asks",
    });
    await seedCutoverPredecessor(client);
    await migrateDatabase(db, {
      through: "20261115001316_background_result_alerts",
    });
    await client.query(
      `INSERT INTO "ImportSourceClaim" (id,"ledgerPartyId",kind,"externalKey",checksum,"firstRunId","lastRunId")
      VALUES ($1,$2,'vendor_export','synthetic:retained-order',$3,$4,$4)`,
      [cutoverId(1000), cutoverId(10), "a".repeat(64), cutoverId(14)],
    );
    const extraction = {
      status: "ready",
      candidate: {
        orderId: "Order ID: SYNTHETIC-ADOPT",
        orderedAt: "2026-01-02",
        merchant: "Synthetic source",
        currency: "USD",
        printedGrandTotal: 60,
        lines: [{ title: "Synthetic line", amount: 60, lineKind: "principal" }],
        payments: [{ amount: 60 }],
      },
    };
    await client.query(
      `INSERT INTO "SourceOrderObservation" (id,"sourceClaimId","orderKey","purchaseId","vendorId",checksum,extraction,"productBindings","contentFingerprint")
      VALUES ($1,$2,'synthetic:order',$3,$4,$5,$6::jsonb,'[]','synthetic-fingerprint')`,
      [
        cutoverId(1002),
        cutoverId(1000),
        cutoverId(4),
        cutoverId(1),
        "a".repeat(64),
        JSON.stringify(extraction),
      ],
    );
    await client.query(
      `INSERT INTO "ImportSourceOrder" (id,"sourceClaimId","orderKey","purchaseId",checksum,"outputFingerprint","acceptedObservationId")
      VALUES ($1,$2,'synthetic:order',$3,$4,'synthetic-fingerprint',$5)`,
      [
        cutoverId(1001),
        cutoverId(1000),
        cutoverId(4),
        "a".repeat(64),
        cutoverId(1002),
      ],
    );
    await client.query(
      `INSERT INTO "ImportSourceProduct" (id,"sourceOrderId","lineIndex","expenseId","productId") VALUES ($1,$2,0,$3,$4)`,
      [cutoverId(1003), cutoverId(1001), cutoverId(7), cutoverId(13)],
    );
    await client.query(
      `INSERT INTO "EmailPurchaseDecision" (id,"eventId","purchaseId",decision,"evidenceChecksum","decidedByUserId",authority,"originalId","emailId")
       VALUES ($1,$2,$3,'linked','synthetic-detached-checksum','synthetic-cutover','member',$4,NULL)`,
      [cutoverId(1010), cutoverId(1011), cutoverId(4), cutoverId(16)],
    );
    await client.query(
      `INSERT INTO "ImportSourceOrder" (id,"sourceClaimId","orderKey","purchaseId",checksum,"outputFingerprint")
       VALUES ($1,$2,$3,$4,$5,'synthetic-missing-extraction')`,
      [
        cutoverId(1020),
        cutoverId(1000),
        `${cutoverId(1)}/receipt/whole`,
        cutoverId(4),
        "b".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO "SourceOrderObservation" (id,"sourceClaimId","orderKey","purchaseId","vendorId",checksum,extraction,"productBindings","contentFingerprint")
       VALUES ($1,$2,$7,$3,$4,$5,$6::jsonb,'[]','synthetic-missing-extraction')`,
      [
        cutoverId(1021),
        cutoverId(1000),
        cutoverId(4),
        cutoverId(1),
        "b".repeat(64),
        JSON.stringify(extraction),
        `${cutoverId(1)}/receipt/whole`,
      ],
    );
    const money = async () =>
      (
        await client.query(`
      SELECT 'expense' source,to_jsonb(r) row FROM "Expense" r
      UNION ALL SELECT 'purchase',to_jsonb(r) FROM "Purchase" r
      UNION ALL SELECT 'transaction',to_jsonb(r) FROM "FinancialTransaction" r
      UNION ALL SELECT 'allocation',to_jsonb(r) FROM "FinancialTransactionAllocation" r
      UNION ALL SELECT 'attribution',to_jsonb(r) FROM "ExpenseAttribution" r
      UNION ALL SELECT 'transfer',to_jsonb(r) FROM "LedgerTransfer" r ORDER BY 1,2`)
      ).rows;
    const before = await money();
    await migrateDatabase(db, {
      through: "20261115175659_order_email_evidence_adoption",
    });
    expect(await money()).toEqual(before);
    expect(
      (
        await client.query(
          `SELECT o.extraction,b.basis FROM "SourceOrderObservation" o
       JOIN "EvidenceBinding" b ON b."factKind"='orderObservation' AND b."factId"=o.id::text
       WHERE o."orderKey"=$1`,
          [`${cutoverId(1)}/receipt/whole`],
        )
      ).rows,
    ).toEqual([
      {
        extraction: {
          status: "unreadable",
          detail: "Retained accepted order identity has no captured extraction",
        },
        basis: "baseline",
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "EvidenceBinding" WHERE "factKind"='orderObservation' AND "factId"=$1`,
          [cutoverId(1021)],
        )
      ).rows[0].n,
    ).toBe(0);

    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "Decision" WHERE subject=$1 AND (id=$2 OR field='purchaseId' OR field=$3)`,
          [
            `mailOriginal:${cutoverId(16)}`,
            cutoverId(1010),
            `review-status:${cutoverId(1010)}`,
          ],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await client.query(
          `SELECT extraction,"ledgerPartyId","sourceExternalKey" FROM "SourceOrderObservation" WHERE id=$1`,
          [cutoverId(1002)],
        )
      ).rows,
    ).toEqual([
      {
        extraction,
        ledgerPartyId: cutoverId(10),
        sourceExternalKey: "synthetic:retained-order",
      },
    ]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "FactKey" WHERE "factKind"='orderObservation' AND "factId"=$2 AND key IN ($1,'payment:amount:USD:6000')`,
          [
            `order:${cutoverId(10)}:${cutoverId(1)}/order/SYNTHETIC-ADOPT`,
            cutoverId(1002),
          ],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "EvidenceBinding" WHERE "factKind"='orderObservation' AND "factId"=$1 AND basis='baseline'`,
          [cutoverId(1002)],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await client.query(
          `SELECT value FROM "Decision" WHERE field='line-record:0'`,
        )
      ).rows,
    ).toEqual([{ value: cutoverId(7) }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "Decision" WHERE id=ANY($1::uuid[])`,
          [[cutoverId(50), cutoverId(52), cutoverId(53)]],
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await client.query(
          `SELECT count(*)::int n FROM "RecordKey" WHERE entity='ledgerTransfer' AND "entityId"=$1`,
          [cutoverId(12)],
        )
      ).rows[0].n,
    ).toBe(1);
    await migrateDatabase(db, {
      through: "20261115175659_order_email_evidence_adoption",
    });
    expect(await money()).toEqual(before);
  });
});
