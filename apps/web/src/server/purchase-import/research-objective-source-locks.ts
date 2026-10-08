import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ResearchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  importHunt,
  run,
  vendorAccount,
} from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

import {
  hasHuntAllocation,
  unfinishedChargeRunOwns,
} from "./charge-hunt-state";
import { researchChargeHuntIds } from "./research-objective";
import { lockVendorResearchScope } from "./vendor-research-scope";

// Account admission and sorted hunts precede Run, task and retained image locks
// for both ordinary continuations and cleanup-authorized successors.
export async function lockObjectiveAccounts(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  frozen: ResearchObjectivesRunInput | null,
) {
  const vendors =
    frozen?.objectives.flatMap((objective) =>
      objective.kind === "vendor_purchases" ? [objective.vendorId] : [],
    ) ?? [];
  for (const id of [...new Set(vendors)].sort()) {
    const active = await lockVendorResearchScope(tx, scope, id, scope.id);
    if (active && active.predecessorRunId !== scope.id)
      throw new Error("Objective has newer active Vendor research.");
  }
  const ids = new Set([
    ...(scope.vendorAccountId ? [scope.vendorAccountId] : []),
    ...(frozen?.objectives.flatMap((objective) =>
      (objective.kind === "account_history" ||
        objective.kind === "charge_hunt") &&
      objective.vendorAccountId
        ? [objective.vendorAccountId]
        : [],
    ) ?? []),
  ]);
  for (const id of [...ids].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    const [account] = await tx
      .select()
      .from(vendorAccount)
      .where(
        and(
          eq(vendorAccount.id, parseEntityId("vendorAccount", id)),
          eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId!),
          notDeleted(vendorAccount),
        ),
      )
      .for("share");
    if (!account)
      throw new Error("Objective account is not owned by this member.");
    const [active] = await tx
      .select({ id: run.id, predecessorRunId: run.predecessorRunId })
      .from(run)
      .where(
        and(
          eq(run.vendorAccountId, account.id),
          ne(run.id, scope.id),
          inArray(run.status, [...ACTIVE_RUN_STATUSES, "dispatch_failed"]),
          notDeleted(run),
        ),
      );
    if (active && active.predecessorRunId !== scope.id)
      throw new Error("Objective account has newer active research.");
  }
}

export async function lockObjectiveHunts(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  frozen: ResearchObjectivesRunInput | null,
) {
  const huntIds =
    frozen?.objectives.flatMap((objective) =>
      objective.kind === "charge_hunt" || objective.kind === "receipt_hunt"
        ? [objective.huntId]
        : [],
    ) ?? researchChargeHuntIds(scope.input);
  return huntIds?.length === 0
    ? []
    : await tx
        .select({
          hunt: importHunt,
          transaction: financialTransaction,
          settled: hasHuntAllocation,
          held: unfinishedChargeRunOwns({
            exceptRunId: scope.id,
            includeReview: true,
          }),
        })
        .from(importHunt)
        .innerJoin(
          financialTransaction,
          and(
            eq(financialTransaction.id, importHunt.financialTransactionId),
            notDeleted(financialTransaction),
          ),
        )
        .innerJoin(
          financialAccount,
          and(
            eq(financialAccount.id, financialTransaction.accountId),
            eq(financialAccount.ledgerPartyId, scope.ledgerPartyId!),
            notDeleted(financialAccount),
          ),
        )
        .where(
          and(
            eq(importHunt.ledgerPartyId, scope.ledgerPartyId!),
            huntIds
              ? inArray(importHunt.id, huntIds)
              : eq(importHunt.receiptRunId, scope.id),
          ),
        )
        .orderBy(asc(importHunt.id))
        .for("update", { of: importHunt });
}
