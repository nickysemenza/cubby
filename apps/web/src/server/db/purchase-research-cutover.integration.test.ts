import { orderMailImportRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  importSourceClaim,
  mailboxCursor,
  orderMail,
  orderMailEvent,
  purchasePaymentEvidence,
  run,
  runOperation,
  runProgress,
  runTarget,
} from "~/server/db/schema";
import { productResearchFixture } from "~/server/purchase-import/product-research.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryFixture,
  createLocationFixture,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  identifier,
  openMainCutover,
  saveTables,
} from "./purchase-research-cutover.fixtures";

const record = z.record(z.string(), z.json());

// Rehearse the actual deploy migrator from populated pre-rewrite tables, not
// isolated UPDATE fragments. Losing signed spend, stock, photos, links or settled
// decisions is a failure; interrupted legacy work must stop occupying admission.
describe("purchase research populated-history cutover", () => {
  const ctx = withTestDb();
  it("preserves populated main through one rewrite migration and fences interrupted legacy work without reopening it", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, {
      complete: true,
    });
    const db = getDb(ctx.db);
    const shelf = await createLocationFixture(
      ctx.db,
      { name: "Synthetic history shelf", type: "cabinet", aliases: [] },
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: f.item.id,
        locationId: shelf.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic signed refund",
      purchaseId: f.order.id,
      productId: f.item.entityId,
      cost: -4,
      date: "2026-09-02",
      costType: "materials",
      trade: "other",
    });
    const body = "Synthetic historical receipt for one small device, USD 24.";
    const checksum = await sha256Hex(body);
    const [mail] = await db
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: "synthetic-original-mailbox",
        messageId: "synthetic-history-original",
        rawChecksum: checksum,
        sender: "orders@example.test",
        subject: "Synthetic historical purchase",
        receivedAt: new Date("2026-09-01T12:00:00Z"),
        content: { snippet: null, bodyHtml: null, bodyText: body },
      })
      .returning();
    if (!mail || !f.association)
      throw new Error("Synthetic retained history missing.");
    const [event] = await db
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: f.order.orderId,
        sourceKey: "synthetic-history-event",
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic lifecycle event missing.");
    await db.insert(mailboxCursor).values({
      ledgerPartyId: f.party.id,
      mailboxId: "synthetic-original-mailbox",
      historyId: "synthetic-history-baseline",
    });
    await db
      .update(importSourceClaim)
      .set({
        externalKey: `gmail:${mail.messageId}:order:${f.order.orderId}`,
        checksum,
      })
      .where(eq(importSourceClaim.id, f.association.sourceClaimId));
    await db.insert(purchasePaymentEvidence).values({
      sourceClaimId: f.association.sourceClaimId,
      purchaseId: f.order.id,
      amount: 24,
      evidenceIndex: 0,
    });
    await db
      .update(run)
      .set({
        purpose: "account_sync",
        status: "running",
        endedAt: null,
        failureCode: null,
        input: orderMailImportRunInput.parse({
          kind: "order_mail_import",
          orders: [
            {
              eventId: event.id,
              evidenceChecksum: checksum,
              orderId: f.order.orderId,
            },
          ],
        }),
      })
      .where(eq(run.id, f.parent.id));
    await db.insert(runTarget).values({
      runId: f.parent.id,
      entityId: f.item.entityId,
      entityKind: "product",
      state: "completed",
      outcome: "enriched",
      targetFingerprint: "a".repeat(64),
      completedAt: new Date("2026-09-01T13:00:00Z"),
    });
    await db.insert(runOperation).values({
      runId: f.parent.id,
      operationId: "synthetic-historical-claim",
      kind: "claim_next_work",
      state: "completed",
      inputFingerprint: "b".repeat(64),
      result: { historicalDecision: "accepted" },
      completedAt: new Date("2026-09-01T13:00:00Z"),
    });
    await db.insert(runProgress).values({
      runId: f.parent.id,
      eventId: "synthetic-member-approval",
      phase: "approved",
      detail: "Synthetic member decision preserved",
    });
    const photoRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "photo_inventory",
      trigger: "manual",
    });
    const completedRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "completed",
    });

    const saved = await saveTables(ctx.db);
    const { client, before, close } = await openMainCutover(saved, (table) =>
      table.name === "ImportSourceClaim"
        ? table.rows.map((row) => ({
            ...row,
            purchaseId: f.order.id,
            outputFingerprint: "c".repeat(64),
          }))
        : table.rows,
    );
    try {
      for (const table of before) {
        const after = (
          await client.query<{ data: z.infer<typeof record> }>(
            `SELECT to_jsonb(t) AS data FROM ${identifier(table.name)} t`,
          )
        ).rows.map((row) => record.parse(row.data));
        for (const row of table.rows) {
          const preserved = { ...row };
          if (table.name === "ImportSourceClaim") {
            delete preserved.purchaseId;
            delete preserved.outputFingerprint;
          }
          if (table.name === "Run") {
            delete preserved.status;
            delete preserved.endedAt;
            delete preserved.failureCode;
            delete preserved.dispatchError;
          }
          expect(after.find((current) => current.id === row.id)).toMatchObject(
            preserved,
          );
        }
      }
      expect(
        (await client.query('SELECT cost FROM "Expense" ORDER BY cost')).rows,
      ).toEqual([{ cost: -4 }, { cost: 24 }]);
      expect(
        (
          await client.query(
            'SELECT "sourceClaimId", "purchaseId", "outputFingerprint" FROM "ImportSourceOrder" WHERE id=$1',
            [f.association.sourceClaimId],
          )
        ).rows,
      ).toEqual([
        {
          sourceClaimId: f.association.sourceClaimId,
          purchaseId: f.order.id,
          outputFingerprint: "c".repeat(64),
        },
      ]);
      expect(
        (
          await client.query(
            'SELECT "mailboxId" FROM "OrderMail" WHERE id=$1',
            [mail.id],
          )
        ).rows,
      ).toEqual([{ mailboxId: `legacy:${f.party.id}` }]);
      expect(
        (
          await client.query(
            'SELECT status, "failureCode", "endedAt", attempt, input FROM "Run" WHERE id=$1',
            [f.parent.id],
          )
        ).rows,
      ).toMatchObject([
        {
          status: "needs_review",
          failureCode: "research_rewrite_required",
          endedAt: expect.any(Date),
          attempt: null,
          input: orderMailImportRunInput.parse({
            kind: "order_mail_import",
            orders: [
              {
                eventId: event.id,
                evidenceChecksum: checksum,
                orderId: f.order.orderId,
              },
            ],
          }),
        },
      ]);
      expect(
        (
          await client.query('SELECT status FROM "Run" WHERE id=$1', [
            photoRunId,
          ])
        ).rows,
      ).toEqual([{ status: "running" }]);
      expect(
        (
          await client.query('SELECT status FROM "Run" WHERE id=$1', [
            completedRunId,
          ])
        ).rows,
      ).toEqual([{ status: "completed" }]);
    } finally {
      await close();
    }
  }, 60_000);
});
