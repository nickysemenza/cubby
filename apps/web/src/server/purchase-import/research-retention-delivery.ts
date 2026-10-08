import { sha256Uuid } from "@cubby/shared/sha256";
import { and, asc, eq, ne } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { researchRetention } from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import { getDb } from "~/server/repo/database-helpers";

/** External receipts survive discarded coordinator histories and failed queue sends. */
export async function publishPendingResearchRetention(
  db: Database,
  options: { receiptId?: string; queue?: PurchaseAgentQueueProducer } = {},
) {
  const pending = await getDb(db)
    .select({
      id: researchRetention.id,
      runId: researchRetention.runId,
    })
    .from(researchRetention)
    .where(
      and(
        ne(researchRetention.phase, "completed"),
        options.receiptId
          ? eq(researchRetention.id, options.receiptId)
          : undefined,
      ),
    )
    .orderBy(asc(researchRetention.createdAt), asc(researchRetention.id))
    .limit(100);
  if (!pending.length) return { queued: 0 };
  const queue = options.queue ?? getPurchaseAgentQueue();
  if (!queue)
    throw new Error(
      "PURCHASE_AGENT_QUEUE binding is unavailable for pending research retention.",
    );
  for (const receipt of pending) {
    await queue.send({
      version: 1,
      type: "research_retention",
      runId: receipt.runId,
      receiptId: receipt.id,
      eventId: await sha256Uuid(`research-retention:${receipt.id}`),
    });
  }
  return { queued: pending.length };
}
