import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  importVendorOrdersInput,
  importVendorOrdersOut,
  type ImportVendorOrdersInput,
} from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  importRun,
  ledgerParty,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { attachPendingOrderMailEvidence } from "./gmail/process";
import { auditAllImportBatches, startOrResumeImportRun } from "./run-service";
import { importVendorOrder } from "./writer";

export async function importVendorOrders(
  db: Database,
  rawInput: ImportVendorOrdersInput,
  actor: ActorContext,
) {
  const input = importVendorOrdersInput.parse(rawInput);
  const accountId = await resolveOrThrow(
    db,
    "vendorAccount",
    input.vendorAccountId,
  );
  const [scope] = await getDb(db)
    .select({
      vendorId: vendorAccount.vendorId,
      ledgerPartyId: vendorAccount.ledgerPartyId,
    })
    .from(vendorAccount)
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, vendorAccount.ledgerPartyId),
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(and(eq(vendorAccount.id, accountId), notDeleted(vendorAccount)))
    .limit(1);
  if (!scope)
    throw new Error("Vendor account is not owned by the authenticated member");

  const run = await startOrResumeImportRun(db, {
    ledgerPartyId: scope.ledgerPartyId,
    vendorAccountId: accountId,
    trigger: "manual",
  });

  try {
    const items = [];
    for (const order of input.orders) {
      const primaryDocumentImageId = order.primaryDocumentImageId
        ? await resolveOrThrow(db, "image", order.primaryDocumentImageId)
        : null;
      const screenshotImageId = order.screenshotImageId
        ? await resolveOrThrow(db, "image", order.screenshotImageId)
        : null;
      const result = await importVendorOrder(
        db,
        {
          runId: run.id,
          ledgerPartyId: scope.ledgerPartyId,
          vendorId: scope.vendorId,
          vendorAccountId: accountId,
          source: order.source,
          extraction: order.extraction,
          primaryDocumentImageId,
          screenshotImageId,
        },
        actor.userId,
      );
      const [row] = result.purchaseId
        ? await getDb(db)
            .select({ shortcode: purchase.shortcode })
            .from(purchase)
            .where(
              eq(purchase.id, parseEntityId("purchase", result.purchaseId)),
            )
            .limit(1)
        : [];
      const orderId = order.extraction.candidate?.orderId;
      if (row && orderId) {
        await attachPendingOrderMailEvidence(db, {
          vendorId: scope.vendorId,
          orderId,
          purchaseShortcode: row.shortcode,
          ledgerPartyId: scope.ledgerPartyId,
        });
      }
      items.push({
        outcome: result.outcome,
        purchaseId: row?.shortcode ?? null,
        findingCount: result.findingIds.length,
      });
    }
    if (run.created) {
      await auditAllImportBatches(db, {
        runId: run.id,
        operationId: "vendor-export-final-audit",
      });
      await getDb(db)
        .update(importRun)
        .set({
          status: "completed",
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(importRun.id, run.id));
    }
    return importVendorOrdersOut.parse({ items });
  } catch (error) {
    if (run.created) {
      await getDb(db)
        .update(importRun)
        .set({ status: "failed", endedAt: new Date(), updatedAt: new Date() })
        .where(eq(importRun.id, run.id));
    }
    throw error;
  }
}
