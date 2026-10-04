import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { vendorChargeHuntsOut } from "@cubby/schemas/order-mail-review";

import type { Database } from "~/server/db";
import { listChargeHunts } from "~/server/purchase-import/charge-runs";

import { sectionBlocks, sectionOut } from "./finance-section";

const OUTCOME_LABEL = {
  pending: "Searching",
  resolved: "Settled",
  deferred: "Needs review",
  not_found: "Order not found",
} as const;

/**
 * A member's statement charges still waiting for an order on this Vendor account. Selecting some
 * starts one browser run for exactly those charges; the rest keep waiting for the normal
 * background search. A charge the server marks with a reason cannot be selected.
 */
export const composeChargeSearchSection = (
  charges: typeof vendorChargeHuntsOut._output,
) =>
  sectionOut({
    items: charges.items.map((charge) => ({
      id: charge.transactionId,
      title: `${charge.merchant ?? "Unknown merchant"} · ${charge.transactionDate ?? "Undated"}`,
      // With a run, the badge and run link say it; without one the reason is the whole story.
      lines: charge.reason && !charge.runId ? [charge.reason] : [],
      amount: charge.amount,
      amountNote: null,
      badge: charge.outcome ? OUTCOME_LABEL[charge.outcome] : null,
      link: charge.runId
        ? { entity: "run" as const, id: charge.runId, label: charge.runId }
        : null,
      disabledReason: charge.reason,
    })),
    emptyText: "No statement charge is waiting for an order on this account.",
    actions:
      charges.items.length === 0
        ? []
        : [
            {
              id: "searchCharges",
              label: "Search selected charges",
              scope: "selection",
              disabledReason: null,
            },
          ],
  });

export const vendorAccountChargeSearchReport = async (
  db: Database,
  id: string,
  actor: ActorContext,
) =>
  sectionBlocks(
    composeChargeSearchSection(
      await listChargeHunts(
        db,
        { vendorAccountId: parseShortcodeFor("vendorAccount", id) },
        actor,
      ),
    ),
  );
