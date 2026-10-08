import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ResearchAssessment } from "@cubby/schemas/research-assessment";
import type { ResearchWorkResolution } from "@cubby/schemas/research-tools";
import {
  CHARGE_HUNT_STATE,
  type ResearchObjective,
} from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  image,
  importHunt,
  run,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { hasHuntAllocation } from "./charge-hunt-state";
import {
  researchObjectiveKey,
  researchObjectivesOf,
} from "./research-objective";

/** A task reference selects an immutable objective, never arbitrary model IDs. */
export function researchObjectiveFor(
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
) {
  const input = researchObjectivesOf(scope.input);
  if (!input) return null;
  if (
    target.runId !== scope.id ||
    target.entityKind !== "run" ||
    target.entityId !== scope.id
  )
    throw new Error("Research objective task identity changed.");
  const objective = input.objectives.find(
    (value) => researchObjectiveKey(value) === target.workKey,
  );
  if (!objective)
    throw new Error("Research objective task is not in the frozen Run input.");
  return objective;
}

async function accountContext(
  db: Database,
  scope: typeof run.$inferSelect,
  accountId: string,
) {
  const [account] = await getDb(db)
    .select({
      accountRef: vendorAccount.shortcode,
      label: vendorAccount.label,
      vendorRef: vendor.shortcode,
      vendorName: vendor.name,
      website: vendor.website,
    })
    .from(vendorAccount)
    .innerJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .where(
      and(
        eq(vendorAccount.id, parseEntityId("vendorAccount", accountId)),
        eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId!),
        notDeleted(vendorAccount),
      ),
    )
    .limit(1);
  if (!account)
    throw new Error("Research objective account is not owned by this member.");
  return account;
}

async function huntContext(
  db: Database,
  scope: typeof run.$inferSelect,
  objective: Extract<
    ResearchObjective,
    { kind: "charge_hunt" | "receipt_hunt" }
  >,
) {
  const [owned] = await getDb(db)
    .select({
      hunt: importHunt,
      transactionId: financialTransaction.id,
      transactionRef: financialTransaction.shortcode,
      merchant: financialTransaction.merchant,
      amount: financialTransaction.amount,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
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
        eq(importHunt.id, objective.huntId),
        eq(importHunt.ledgerPartyId, scope.ledgerPartyId!),
      ),
    )
    .limit(1);
  if (
    !owned ||
    (objective.kind === "charge_hunt" &&
      (owned.transactionId !== objective.financialTransactionId ||
        owned.hunt.vendorAccountId !== objective.vendorAccountId))
  )
    throw new Error(
      "Research objective hunt is not owned or changed identity.",
    );
  return {
    hunt: owned.hunt,
    charge: {
      transactionRef: owned.transactionRef,
      merchant: owned.merchant,
      amount: owned.amount,
      transactionDate: owned.transactionDate,
      postedDate: owned.postedDate,
    },
  };
}

export async function assertReceiptObjectiveOriginal(
  db: Database,
  scope: typeof run.$inferSelect,
  objective: Extract<ResearchObjective, { kind: "receipt_hunt" }>,
) {
  const { hunt, charge } = await huntContext(db, scope, objective);
  if (
    hunt.receiptRunId !== scope.id ||
    hunt.receiptImageId !== objective.imageId
  )
    throw new Error(
      "Selected receipt no longer belongs to this research objective.",
    );
  const [original] = await getDb(db)
    .select()
    .from(image)
    .where(
      and(
        eq(image.id, parseEntityId("image", objective.imageId)),
        eq(image.status, "UPLOADED"),
        notDeleted(image),
      ),
    )
    .for("share")
    .limit(1);
  if (!original || original.sha256 !== objective.checksum)
    throw new Error(
      "Selected receipt original checksum changed or is unavailable.",
    );
  return { original, hunt, charge };
}

export async function loadResearchObjectiveContext(
  db: Database,
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
) {
  const objective = researchObjectiveFor(scope, target);
  if (!objective) return null;
  if (!scope.ledgerPartyId)
    throw new Error("Research objective member scope is missing.");
  if (objective.kind === "vendor_purchases") {
    const [seller] = await getDb(db)
      .select({
        vendorRef: vendor.shortcode,
        name: vendor.name,
        website: vendor.website,
        knownSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(
        and(
          eq(vendor.id, parseEntityId("vendor", objective.vendorId)),
          notDeleted(vendor),
        ),
      )
      .limit(1);
    if (!seller) throw new Error("Research Vendor is unavailable.");
    return {
      workRef: target.id,
      kind: objective.kind,
      vendor: seller,
      range: objective.range,
      instruction:
        "Investigate this Vendor's purchases using owned mail and other available sources. Names, senders, and website are leads, not exclusion rules. Keep unsupported or ambiguous matches unresolved. Scoped search does not advance whole-mailbox coverage; retain exhaustion evidence or explicit gaps.",
    };
  }
  if (objective.kind === "account_history")
    return {
      workRef: target.id,
      kind: objective.kind,
      account: await accountContext(db, scope, objective.vendorAccountId),
      range: objective.range,
      cursor: objective.cursor,
      instruction:
        "Investigate the entire frozen history scope. Imported individual orders do not prove that history is exhausted; retain scope-completion evidence or explicit gaps.",
    };
  if (objective.kind === "charge_hunt") {
    const { hunt, charge } = await huntContext(db, scope, objective);
    return {
      workRef: target.id,
      kind: objective.kind,
      huntRef: hunt.id,
      charge: { transactionRef: charge.transactionRef, ...objective.charge },
      account: objective.vendorAccountId
        ? await accountContext(db, scope, objective.vendorAccountId)
        : null,
      range: objective.range,
      instruction:
        "Investigate only this selected charge. Receipt or order identity does not establish financial allocation; preserve missing dates and amounts.",
    };
  }
  const { original, charge } = await assertReceiptObjectiveOriginal(
    db,
    scope,
    objective,
  );
  return {
    workRef: target.id,
    kind: objective.kind,
    charge,
    receipt: {
      imageRef: original.shortcode,
      checksum: objective.checksum,
      filename: original.filename,
      mimeType: original.contentType,
    },
    instruction:
      "Read the selected original using work_observe read. Interpret the receipt before importing supported orders; its charge context is a lead, not proof of itemization or payment reconciliation.",
  };
}

/** Imported orders do not prove account traversal or financial reconciliation. */
export async function reconcileResearchObjective(
  db: Database,
  input: {
    scope: typeof run.$inferSelect;
    target: typeof runTarget.$inferSelect;
    proposal: ResearchWorkResolution;
    assessment: ResearchAssessment;
    status: ResearchWorkResolution["status"];
  },
) {
  const objective = researchObjectiveFor(input.scope, input.target);
  if (!objective)
    return { status: input.status, warning: input.proposal.detail };
  const gaps = [...(input.proposal.progress?.gaps ?? [])];
  if (
    objective.kind === "account_history" ||
    objective.kind === "vendor_purchases"
  ) {
    if (
      !input.proposal.progress?.scopeExhausted ||
      !input.proposal.progress.evidenceIds.length ||
      !input.assessment.scopeCompletionVerified
    )
      gaps.push(
        "The complete frozen research scope has no supported exhaustion evidence.",
      );
  } else {
    await huntContext(db, input.scope, objective);
    const noOrderFound =
      input.status === "no_source_found" &&
      input.proposal.progress?.scopeExhausted &&
      input.assessment.scopeCompletionVerified;
    const unresolvedState = noOrderFound
      ? CHARGE_HUNT_STATE.notFound
      : CHARGE_HUNT_STATE.deferred;
    const error = noOrderFound
      ? input.proposal.detail
      : "Receipt/order research completed; financial reconciliation remains for review.";
    await getDb(db)
      .update(importHunt)
      .set({
        state: sql`CASE WHEN ${hasHuntAllocation} THEN ${CHARGE_HUNT_STATE.resolved} ELSE ${unresolvedState} END`,
        error: sql`CASE WHEN ${hasHuntAllocation} THEN NULL ELSE ${error} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importHunt.id, objective.huntId),
          eq(importHunt.ledgerPartyId, input.scope.ledgerPartyId!),
        ),
      );
  }
  return {
    status: gaps.length ? ("researched_with_gaps" as const) : input.status,
    warning: gaps.length
      ? [input.proposal.detail, ...gaps].join("\n")
      : input.proposal.detail,
  };
}
