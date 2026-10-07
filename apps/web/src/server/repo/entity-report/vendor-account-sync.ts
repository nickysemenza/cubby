import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { loadSyncPlan } from "~/server/purchase-import/account-sync";
import { currentMemberLedgerParty } from "~/server/repo/member-login";

import { sectionBlocks, sectionOut } from "./finance-section";

export async function vendorAccountSyncReport(
  db: Database,
  id: string,
  actor: ActorContext,
) {
  const party = await currentMemberLedgerParty(db, actor);
  const plan = party
    ? (
        await loadSyncPlan(db, party.id, {
          vendorAccountId: parseShortcodeFor("vendorAccount", id),
        })
      ).accounts[0]
    : undefined;
  const reason =
    plan?.disabledReason ??
    (plan
      ? null
      : "Browser sync is unavailable: enable it on an active account owned by this member.");
  return sectionBlocks(
    sectionOut({
      items: plan
        ? [
            {
              id: plan.shortcode,
              title: plan.line,
              lines: [],
              amount: null,
              amountNote: null,
              badge: null,
              link:
                plan.action.kind === "resume" || plan.action.kind === "blocked"
                  ? {
                      entity: "run",
                      id: plan.action.runId,
                      label: plan.action.runId,
                    }
                  : null,
              disabledReason: null,
            },
          ]
        : [],
      emptyText: reason,
      notes: [
        "To find an order for a statement charge, use Statement charges below. To re-read a specific order, open its Purchase and choose Validate ingestion.",
      ],
      actions: [
        {
          id: "syncAccount",
          label: "Sync now",
          scope: "section",
          disabledReason: reason,
        },
      ],
    }),
  );
}
