import type { ActorContext } from "@cubby/schemas/context";
import type {
  SuggestionCorrectionOutcome,
  SuggestionCorrectionPlan,
} from "@cubby/schemas/suggestion-correction";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  statementTransactionCorrectionRepair,
  transferPairCorrectionRepair,
} from "~/server/domains/financial-transaction/repo/financial-suggestion-correction";
import type { CorrectionRepairAdapter } from "~/server/generic/assessment/correction-repair";
import { fieldCorrectionRepair } from "~/server/generic/assessment/repo/field-correction-repair";
import type { ReviewFamily } from "~/server/generic/assessment/repo/review-families";

const heldAdapter = (reason: string): CorrectionRepairAdapter<z.ZodNever> => ({
  plan: z.never(),
  prepare: async () => ({ status: "held", reason }),
  apply: async () => ({ status: "held", reason }),
});

type PreparedRepair =
  | { status: "held"; reason: string }
  | {
      status: "ready";
      domainPlan: z.infer<ReturnType<typeof z.json>>;
      apply: (
        db: Database,
        actor: ActorContext,
      ) => Promise<SuggestionCorrectionOutcome>;
    };

/** Keep each adapter's schema and payload paired without an untyped plan cast. */
function register<Schema extends z.ZodType>(
  adapter: CorrectionRepairAdapter<Schema>,
) {
  return async (
    db: Database,
    input: SuggestionCorrectionPlan,
  ): Promise<PreparedRepair> => {
    const prepared = await adapter.prepare(db, input);
    if (prepared.status === "held") return prepared;
    const plan = adapter.plan.parse(prepared.plan);
    return {
      status: "ready",
      domainPlan: z.json().parse(plan),
      apply: (transactionDb, actor) =>
        adapter.apply(transactionDb, input, plan, actor),
    };
  };
}

/** Exhaustive support declarations: registering a family never grants domain authority. */
export const correctionRepairFamilies = {
  field: register(fieldCorrectionRepair),
  statement_transaction: register(statementTransactionCorrectionRepair),
  transfer_pair: register(transferPairCorrectionRepair),
  image_description: register(
    heldAdapter("Image corrections need a content-bound propagation adapter"),
  ),
  email_relevance: register(
    heldAdapter(
      "Email correction propagation requires current owned-original routing proof",
    ),
  ),
  email_link: register(
    heldAdapter(
      "Email links require independent current Purchase identity evidence",
    ),
  ),
  mail_import_outcome: register(
    heldAdapter(
      "Mail import outcome Feedback is history-only, not import repair authority",
    ),
  ),
  product_pair: register(
    heldAdapter(
      "Product merges require supported pair identity and survivor authority",
    ),
  ),
  recommendation: register(
    heldAdapter(
      "Recommendation correction scope and effects belong to its declared subtype",
    ),
  ),
} satisfies Record<
  ReviewFamily,
  (db: Database, input: SuggestionCorrectionPlan) => Promise<PreparedRepair>
>;
