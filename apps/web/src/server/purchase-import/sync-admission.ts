import { runShortcode, type VendorAccountId } from "@cubby/schemas/identifiers";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { DrizzleClient, DrizzleTransaction } from "~/server/db";
import { run, vendor, vendorAccount } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

import {
  chargeResearchRunPredicate,
  researchChargeHuntIds,
} from "./research-objective";

/** Both the plan and locked start require a live, enabled account and Vendor. */
export function accountSyncEligibility() {
  return sql<boolean>`${and(
    eq(vendorAccount.browserSyncEnabled, true),
    inArray(vendorAccount.status, ["active", "paused_auth", "paused_offline"]),
    notDeleted(vendorAccount),
    notDeleted(vendor),
  )}`;
}

/** A failed charge dispatch still owns the selected hunts. */
export const CHARGE_HOLDING_STATUSES = [
  ...ACTIVE_RUN_STATUSES,
  "dispatch_failed",
] as const;

/** Shared by the advisory plan and transaction-locked admission. Charge searches never join a sync. */
export async function readAccountSyncAdmission(
  db: DrizzleClient | DrizzleTransaction,
  accountId: VendorAccountId,
) {
  const [held] = await db
    .select({
      id: run.id,
      shortcode: run.shortcode,
      purpose: run.purpose,
      status: run.status,
      input: run.input,
      vendorId: run.vendorId,
      failureCode: run.failureCode,
      dispatchError: run.dispatchError,
    })
    .from(run)
    .where(
      and(
        eq(run.vendorAccountId, accountId),
        or(
          inArray(run.status, [...ACTIVE_RUN_STATUSES]),
          and(
            eq(run.status, "dispatch_failed"),
            chargeResearchRunPredicate(run.input),
          ),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${chargeResearchRunPredicate(run.input)} THEN 0 WHEN ${run.purpose} != 'account_sync' THEN 1 ELSE 2 END`,
      desc(run.createdAt),
      desc(run.id),
    )
    .limit(1);
  if (!held) return null;
  const isChargeSearch = researchChargeHuntIds(held.input) !== null;
  return {
    isChargeSearch,
    kind:
      held.purpose === "account_sync" && !isChargeSearch
        ? ("resume" as const)
        : ("blocked" as const),
    run: {
      ...held,
      shortcode: runShortcode.parse(held.shortcode),
      purpose: runPurpose.parse(held.purpose),
      status: runStatus.parse(held.status),
    },
  };
}
