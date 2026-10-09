import { plainDate } from "@cubby/schemas/base-entity";
import { financialTransactionNonZeroAmount } from "@cubby/schemas/financial-transaction-fields";
import {
  chargeHuntRunInput,
  orderBackfillRunInput,
  researchObjectivesRunInput,
  type ResearchObjective,
} from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import { run, runOperation } from "~/server/db/schema";

import { CHARGE_RESEARCH_UNRESOLVED_STATES } from "./charge-hunt-state";
import { OBJECTIVE_RESEARCH_INSTRUCTION_REVISION } from "./research-objective";
import type { lockObjectiveHunts } from "./research-objective-source-locks";

const historicalHuntClaim = z.object({
  kind: z.literal("hunt"),
  id: z.uuid(),
  amount: financialTransactionNonZeroAmount,
  dateFrom: plainDate,
  dateTo: plainDate,
});

export function isHistoricalObjectiveInput(input: unknown) {
  return (
    orderBackfillRunInput.safeParse(input).success ||
    chargeHuntRunInput.safeParse(input).success
  );
}

async function retainedHistoricalChargeClaims(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  ids: readonly string[],
) {
  const records = await tx
    .select({ result: runOperation.result })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, scope.id),
        eq(runOperation.kind, "claim_next_work"),
        eq(runOperation.state, "completed"),
      ),
    )
    .for("share");
  const claims = new Map<string, z.infer<typeof historicalHuntClaim>>();
  for (const record of records) {
    if (
      z.object({ kind: z.string() }).safeParse(record.result).data?.kind !==
      "hunt"
    )
      continue;
    const parsed = historicalHuntClaim.safeParse(record.result);
    if (
      !parsed.success ||
      !ids.includes(parsed.data.id) ||
      parsed.data.dateFrom > parsed.data.dateTo
    )
      throw new Error(
        "Historical charge observation is outside its saved Hunt selection or invalid.",
      );
    const previous = claims.get(parsed.data.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed.data))
      throw new Error(
        "Historical charge observations contain conflicting retained amount or range facts.",
      );
    claims.set(parsed.data.id, parsed.data);
  }
  return claims;
}

function assertHistoricalChargeOwners(
  scope: typeof run.$inferSelect,
  ids: readonly string[],
  hunts: Awaited<ReturnType<typeof lockObjectiveHunts>>,
) {
  if (
    new Set(ids).size !== ids.length ||
    hunts.length !== ids.length ||
    !scope.vendorAccountId ||
    hunts.some(
      (found) =>
        found.hunt.vendorAccountId !== scope.vendorAccountId ||
        !ids.includes(found.hunt.id),
    )
  )
    throw new Error(
      "Historical charge selection or financial-account ownership changed.",
    );
}

/** Old selected Hunts read live context at claim time; this freezes their first new admission. */
export async function convertHistoricalObjectives(
  tx: DrizzleTransaction,
  scope: typeof run.$inferSelect,
  hunts: Awaited<ReturnType<typeof lockObjectiveHunts>>,
) {
  if (!scope.vendorAccountId)
    throw new Error("Historical account scope has no owned account.");
  const backfill = orderBackfillRunInput.safeParse(scope.input);
  if (backfill.success) {
    if (backfill.data.from > backfill.data.to)
      throw new Error("Historical account backfill range is invalid.");
    return researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: scope.vendorAccountId,
          range: { from: backfill.data.from, to: backfill.data.to },
          cursor: null,
        },
      ],
    });
  }
  const selected = chargeHuntRunInput.parse(scope.input);
  assertHistoricalChargeOwners(scope, selected.huntIds, hunts);
  const claims = await retainedHistoricalChargeClaims(
    tx,
    scope,
    selected.huntIds,
  );
  const objectives: ResearchObjective[] = [];
  for (const id of selected.huntIds) {
    const found = hunts.find((found) => found.hunt.id === id);
    if (!found) throw new Error("Historical charge Hunt is unavailable.");
    if (
      found.settled ||
      found.held ||
      !CHARGE_RESEARCH_UNRESOLVED_STATES.some(
        (state) => state === found.hunt.state,
      )
    )
      continue;
    const observed = claims.get(id);
    objectives.push({
      kind: "charge_hunt",
      huntId: id,
      financialTransactionId: found.transaction.id,
      vendorAccountId: scope.vendorAccountId,
      range: observed
        ? { from: observed.dateFrom, to: observed.dateTo }
        : { from: found.hunt.dateFrom, to: found.hunt.dateTo },
      charge: observed
        ? {
            amount: observed.amount,
            merchant: null,
            rawDescription: null,
            transactionDate: null,
            postedDate: null,
          }
        : {
            amount: found.transaction.amount,
            merchant: found.transaction.merchant,
            rawDescription: found.transaction.rawDescription,
            transactionDate: found.transaction.transactionDate,
            postedDate: found.transaction.postedDate,
          },
    });
  }
  if (!objectives.length)
    throw new Error(
      "Historical charge selection has no eligible unresolved work.",
    );
  return researchObjectivesRunInput.parse({
    kind: "research_objectives",
    instructionRevision: OBJECTIVE_RESEARCH_INSTRUCTION_REVISION,
    objectives,
  });
}
