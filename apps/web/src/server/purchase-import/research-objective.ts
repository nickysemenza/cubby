import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import {
  researchObjectivesRunInput,
  chargeHuntRunInput,
  orderBackfillRunInput,
  type OrderBackfillRunInput,
  type ResearchObjective,
  type ResearchObjectivesRunInput,
} from "@cubby/schemas/run-fields";
import { vendorAccountCursor } from "@cubby/schemas/vendor-account-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  importHunt,
  run,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

export const OBJECTIVE_RESEARCH_INSTRUCTION_REVISION = 1;

/** Each frozen objective has one server-owned task across interrupted admission. */
export function researchObjectiveKey(objective: ResearchObjective) {
  return objective.kind === "vendor_purchases"
    ? `vendor:${objective.vendorId}`
    : objective.kind === "account_history"
      ? `account:${objective.vendorAccountId}`
      : `${objective.kind}:${objective.huntId}`;
}

export async function admitResearchObjectiveTargets(
  tx: DrizzleTransaction,
  input: { runId: string; objectives: ResearchObjectivesRunInput },
) {
  const objectives = researchObjectivesRunInput.parse(input.objectives);
  const keys = objectives.objectives.map(researchObjectiveKey);
  if (new Set(keys).size !== keys.length)
    throw new Error("Research objectives contain duplicate work identities.");
  const runId = runEntityId.parse(input.runId);
  const targets = await Promise.all(
    objectives.objectives.map(async (objective, position) => ({
      runId,
      entityKind: "run" as const,
      entityId: runId,
      workKey: researchObjectiveKey(objective),
      sourceKind:
        objective.kind === "receipt_hunt" ? "receipt_photo" : objective.kind,
      sourceExternalKey:
        objective.kind === "vendor_purchases"
          ? objective.vendorId
          : objective.kind === "account_history"
            ? objective.vendorAccountId
            : objective.huntId,
      vendorAccountId:
        objective.kind === "receipt_hunt" ||
        objective.kind === "vendor_purchases" ||
        !objective.vendorAccountId
          ? null
          : parseEntityId("vendorAccount", objective.vendorAccountId),
      targetFingerprint: await sha256Hex(
        JSON.stringify([objectives.instructionRevision, objective]),
      ),
      state: "pending" as const,
      position,
    })),
  );
  await tx.insert(runTarget).values(targets).onConflictDoNothing();
}

export function researchObjectivesOf(input: unknown) {
  const parsed = researchObjectivesRunInput.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Frozen inputs are created under the same transaction as their Run and tasks. */
export async function freezeAccountResearchObjectives(
  tx: DrizzleTransaction,
  input: Pick<typeof run.$inferSelect, "ledgerPartyId" | "vendorAccountId"> & {
    range: { from: string; to: string } | null;
    chargeHuntIds: readonly string[] | null;
  },
): Promise<ResearchObjectivesRunInput> {
  if (!input.ledgerPartyId || !input.vendorAccountId)
    throw new Error("Research account scope is missing.");
  const [account] = await tx
    .select()
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.id, input.vendorAccountId),
        eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
        notDeleted(vendorAccount),
      ),
    )
    .for("share");
  if (!account)
    throw new Error("Research account is not owned by this member.");
  let objectives: ResearchObjective[];
  if (input.chargeHuntIds) {
    const ids = [...input.chargeHuntIds];
    const hunts = await tx
      .select({ hunt: importHunt, transaction: financialTransaction })
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
          eq(financialAccount.ledgerPartyId, input.ledgerPartyId),
          notDeleted(financialAccount),
        ),
      )
      .where(
        and(
          eq(importHunt.ledgerPartyId, input.ledgerPartyId),
          eq(importHunt.vendorAccountId, input.vendorAccountId),
          inArray(importHunt.id, ids),
        ),
      )
      .for("update", { of: importHunt });
    if (hunts.length !== ids.length || new Set(ids).size !== ids.length)
      throw new Error(
        "Research charge selection is missing, duplicated, or outside this member's account.",
      );
    objectives = ids.map((id) => {
      const found = hunts.find((row) => row.hunt.id === id);
      if (!found) throw new Error("Selected research hunt is unavailable.");
      return {
        kind: "charge_hunt",
        huntId: id,
        financialTransactionId: found.transaction.id,
        vendorAccountId: input.vendorAccountId,
        range: { from: found.hunt.dateFrom, to: found.hunt.dateTo },
        charge: {
          merchant: found.transaction.merchant,
          rawDescription: found.transaction.rawDescription,
          amount: found.transaction.amount,
          transactionDate: found.transaction.transactionDate,
          postedDate: found.transaction.postedDate,
        },
      };
    });
  } else
    objectives = [
      {
        kind: "account_history",
        vendorAccountId: input.vendorAccountId,
        range: input.range,
        cursor: vendorAccountCursor.nullable().parse(account.cursor),
      },
    ];
  return researchObjectivesRunInput.parse({
    kind: "research_objectives",
    instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
    objectives,
  });
}

export function researchChargeHuntIds(input: unknown): string[] | null {
  const parsed = researchObjectivesRunInput.safeParse(input);
  const frozen = parsed.success ? parsed.data : null;
  const ids =
    frozen?.objectives.flatMap((objective) =>
      objective.kind === "charge_hunt" ? [objective.huntId] : [],
    ) ?? [];
  if (ids.length) return ids;
  const historical = chargeHuntRunInput.safeParse(input);
  return historical.success ? historical.data.huntIds : null;
}

/** Shared query shape for account admission and selected-hunt ownership. */
export function chargeResearchRunPredicate(input: SQLWrapper) {
  return sql<boolean>`(${input}->>'kind' = 'charge_hunts' OR (${input}->>'kind' = 'research_objectives' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN ${input}->>'kind' = 'research_objectives' THEN ${input}->'objectives' ELSE '[]'::jsonb END) objective
    WHERE objective->>'kind' = 'charge_hunt'
  )))`;
}

/** A range never resumes another active objective on the same browser account. */
export async function assertAccountBackfillAdmission(
  tx: DrizzleTransaction,
  accountId: NonNullable<typeof run.$inferSelect.vendorAccountId>,
  range: OrderBackfillRunInput | null,
) {
  if (!range) return;
  const [active] = await tx
    .select({ input: run.input })
    .from(run)
    .where(
      and(
        eq(run.vendorAccountId, accountId),
        inArray(run.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .limit(1);
  if (!active) return;
  const frozenRange = researchObjectivesOf(active.input)?.objectives.find(
    (objective) => objective.kind === "account_history",
  )?.range;
  const prior = orderBackfillRunInput.safeParse(
    frozenRange ? { kind: "order_backfill", ...frozenRange } : active.input,
  );
  if (
    !prior.success ||
    prior.data.from !== range.from ||
    prior.data.to !== range.to
  )
    throw new Error(
      "Vendor account already has an active import run; finish or stop it before starting this backfill",
    );
}
