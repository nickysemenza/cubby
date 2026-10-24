import type { ActorContext } from "@cubby/schemas/context";
import type {
  SuggestionCorrectionOutcome,
  SuggestionCorrectionPlan,
} from "@cubby/schemas/suggestion-correction";
import type { z } from "zod";

import type { Database } from "~/server/db";

type CorrectionPreparation<Plan> =
  | { status: "ready"; plan: Plan }
  | { status: "held"; reason: string };

/**
 * The coordinator owns the serializable publication boundary. apply receives
 * its transaction-bound Database; a domain must not upgrade a caller's transaction.
 * Model applicability never supplies source-proof or member-edit authority.
 */
export type CorrectionRepairAdapter<Schema extends z.ZodType> = {
  plan: Schema;
  prepare: (
    db: Database,
    input: SuggestionCorrectionPlan,
  ) => Promise<CorrectionPreparation<z.output<Schema>>>;
  apply: (
    db: Database,
    input: SuggestionCorrectionPlan,
    plan: z.output<Schema>,
    actor: ActorContext,
  ) => Promise<SuggestionCorrectionOutcome>;
};
