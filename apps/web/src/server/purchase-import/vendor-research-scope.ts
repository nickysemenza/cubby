import { parseEntityId } from "@cubby/schemas/identifiers";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { run, vendor } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

/** Fresh launches and successors share one member/Vendor admission fence. */
export async function lockVendorResearchScope(
  tx: DrizzleTransaction,
  scope: Pick<typeof run.$inferSelect, "ledgerPartyId" | "actorUserId">,
  vendorRef: string,
  exceptRunId?: (typeof run.$inferSelect)["id"],
) {
  if (!scope.ledgerPartyId || !scope.actorUserId)
    throw new Error("Vendor research requires the owning member.");
  const vendorId = parseEntityId("vendor", vendorRef);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`vendor-research:${scope.ledgerPartyId}:${vendorId}`}))`,
  );
  const [seller] = await tx
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), notDeleted(vendor)))
    .for("share");
  if (!seller) throw new Error("Research Vendor is unavailable.");
  const [active] = await tx
    .select()
    .from(run)
    .where(
      and(
        eq(run.ledgerPartyId, scope.ledgerPartyId),
        eq(run.actorUserId, scope.actorUserId),
        eq(run.vendorId, vendorId),
        eq(run.purpose, "account_sync"),
        sql`${run.input}->>'kind' = 'research_objectives' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${run.input}->'objectives') objective
          WHERE objective->>'kind' = 'vendor_purchases' AND objective->>'vendorId' = ${vendorId}
        )`,
        exceptRunId ? ne(run.id, exceptRunId) : undefined,
        inArray(run.status, [...ACTIVE_RUN_STATUSES, "dispatch_failed"]),
        notDeleted(run),
      ),
    );
  return active;
}
