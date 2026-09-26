import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { parseEntityId, vendorAccountId } from "@cubby/schemas/identifiers";
import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { expense, product, purchase } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import type { AttachOrderMailFile } from "./gmail/process";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startOrResumeRun } from "./run-service";

type HistoryLine = {
  title: string;
  amount: number;
  lineKind?: ExpenseLineKind;
};

/**
 * Drives one order-history capture through the real prepare/commit boundary
 * the browser agent uses. Each principal line resolves to a fresh Product so
 * the commit neither waits on review nor depends on product matching.
 */
export async function importOrderHistory(
  db: Database,
  actor: ActorContext,
  input: {
    ledgerPartyId: string;
    vendorAccountId: string;
    orderId: string;
    orderedAt: string;
    lines: readonly HistoryLine[];
    /** One hex digit; a new digit is a source refresh of the same order. */
    revision: string;
  },
  attachMailFile?: AttachOrderMailFile,
) {
  const run = await startOrResumeRun(db, {
    ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
    vendorAccountId: vendorAccountId.parse(input.vendorAccountId),
    trigger: "manual",
  });
  const stableOrderId = `${input.orderId}-${input.revision}`.toLowerCase();
  const lineIds = input.lines.map(
    (_, index) => `${stableOrderId}:line-${index + 1}`,
  );
  const prepareOperationId = `prepare:${stableOrderId}`;
  await preparePurchaseImport(
    db,
    {
      _runExecution: {
        runId: run.id,
        operationId: prepareOperationId,
        itemOperationIds: [`item:${stableOrderId}`],
      },
      orders: [
        {
          stableOrderId,
          itemOperationId: `item:${stableOrderId}`,
          source: {
            kind: "browser_order",
            externalKey: `history:order:${input.orderId}`,
            checksum: input.revision.repeat(64),
          },
          evidenceChecksum: input.revision.repeat(64),
          extractionRevision: "history@fixture-1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: input.orderId,
              orderedAt: input.orderedAt,
              merchant: "ForgeWear",
              currency: "USD",
              printedGrandTotal:
                input.lines.reduce(
                  (total, line) => total + Math.round(line.amount * 100),
                  0,
                ) / 100,
              lines: input.lines.map((line) => ({
                title: line.title,
                amount: line.amount,
                lineKind: line.lineKind ?? "principal",
              })),
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds,
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    },
    actor,
  );
  const resolutions = [];
  for (const [index, line] of input.lines.entries()) {
    if ((line.lineKind ?? "principal") !== "principal") continue;
    const created = await createProductFixture(
      db,
      makeProductInput({ name: `${line.title} ${stableOrderId}` }),
      actor,
    );
    const [row] = await getDb(db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    if (!row) throw new Error("test setup: product fixture not created");
    resolutions.push({
      stableOrderId,
      stableLineId: lineIds[index],
      resolution: { kind: "existing", productId: row.shortcode },
    });
  }
  const result = await commitPurchaseImport(
    db,
    commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: `commit:${stableOrderId}` },
      prepareOperationId,
      defaultTrade: "other",
      resolutions,
    }),
    actor,
    attachMailFile,
  );
  return result.items[0];
}

/** Live Expense costs on a Purchase, in cents, sorted — the SUM(Expense.cost) view. */
export async function liveExpenseCents(db: Database, purchaseId: string) {
  const rows = await getDb(db)
    .select({ cost: expense.cost })
    .from(expense)
    .where(
      and(
        eq(expense.purchaseId, parseEntityId("purchase", purchaseId)),
        notDeleted(expense),
      ),
    );
  return rows
    .map((row) => Math.round((row.cost ?? 0) * 100))
    .sort((a, b) => a - b);
}

export async function purchasesForOrder(db: Database, orderId: string) {
  return getDb(db)
    .select({ id: purchase.id, shortcode: purchase.shortcode })
    .from(purchase)
    .where(and(eq(purchase.orderId, orderId), notDeleted(purchase)));
}
