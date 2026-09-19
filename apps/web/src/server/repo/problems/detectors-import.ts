import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  importFinding,
  importHunt,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

export async function findOpenImportFindings(db: Database) {
  const rows = await getDb(db)
    .select({
      id: importFinding.id,
      purchaseShortcode: purchase.shortcode,
      kind: importFinding.kind,
      summary: importFinding.summary,
      probability: importFinding.probability,
      proposedFix: importFinding.proposedFix,
      createdAt: importFinding.createdAt,
    })
    .from(importFinding)
    .leftJoin(purchase, eq(importFinding.targetId, purchase.id))
    .where(eq(importFinding.status, "open"))
    .orderBy(importFinding.createdAt);
  const findings = rows.map((row) => ({
    id: row.id,
    purchaseId: row.purchaseShortcode
      ? parseShortcodeFor("purchase", row.purchaseShortcode)
      : null,
    kind: row.kind,
    summary: row.summary,
    probability: row.probability,
    proposedFix: row.proposedFix,
    createdAt: row.createdAt,
  }));
  const hunts = await getDb(db)
    .select({
      id: importHunt.id,
      state: importHunt.state,
      error: importHunt.error,
      createdAt: importHunt.createdAt,
    })
    .from(importHunt)
    .where(
      inArray(importHunt.state, [
        "receipt_required",
        "expected_order_not_found",
        "receipt_failed",
      ]),
    )
    .orderBy(importHunt.createdAt);
  const pausedAccounts = await getDb(db)
    .select({
      id: vendorAccount.id,
      label: vendorAccount.label,
      status: vendorAccount.status,
      updatedAt: vendorAccount.updatedAt,
    })
    .from(vendorAccount)
    .where(
      and(
        inArray(vendorAccount.status, ["paused_auth", "paused_offline"]),
        notDeleted(vendorAccount),
      ),
    )
    .orderBy(vendorAccount.updatedAt);
  return [
    ...findings,
    ...hunts.map((hunt) => ({
      id: hunt.id,
      purchaseId: null,
      kind: hunt.state,
      summary:
        hunt.error ??
        (hunt.state === "receipt_required"
          ? "A statement charge needs a confirmed receipt photo."
          : "Purchase evidence could not be matched to this charge."),
      probability: null,
      proposedFix: null,
      createdAt: hunt.createdAt,
    })),
    ...pausedAccounts.map((account) => ({
      id: account.id,
      purchaseId: null,
      kind: account.status === "paused_auth" ? "auth_required" : "other",
      summary:
        account.status === "paused_auth"
          ? `${account.label} needs you to sign in again in its browser.`
          : `${account.label} is waiting for its Mac browser bridge to reconnect.`,
      probability: null,
      proposedFix: null,
      createdAt: account.updatedAt,
    })),
  ];
}
