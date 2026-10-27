import type { AiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import type { z } from "zod";

import type { AiRunContext } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import type { aiEvaluation } from "~/server/db/retained-tables";
import type { WorkItem } from "~/server/generic/jobs/repo/work-items";

/** Pages are transient; each slot keeps its drain item and frozen evidence. */
export type EvaluationPageTarget = {
  item: WorkItem;
  evaluation: typeof aiEvaluation.$inferSelect;
  target: AiEvaluationTarget;
};

export type EvaluationPagePreparation<P> =
  | {
      kind: "ready";
      target: EvaluationPageTarget;
      /** Target-local evidence, never a digest of the page or its siblings. */
      evidenceDigest: string;
      prepared: P;
    }
  | { kind: "failed"; target: EvaluationPageTarget; error: Error };

export type EvaluationPageOutcome<O> = {
  target: EvaluationPageTarget;
  evidenceDigest: string;
  outcome: O;
};

export type EvaluationPagePublication = {
  evaluationId: string;
  state: "completed" | "blocked" | "obsolete";
  receipt: z.infer<ReturnType<typeof z.json>>;
};

/**
 * prepare loads a finite set outside write transactions. evaluate runs in the
 * target's captured execution context and a shared decision-work wave. publish
 * receives only currently authorized targets (at most 25 weight) in one
 * fenced drain chunk, without an arbitrary target's AsyncLocal context.
 * It must check each evidenceDigest before business writes and return one
 * validity/receipt per outcome. An obsolete target must make no business writes.
 * Large source-to-pair rosters must enroll bounded, idempotent edge chunks
 * before returning their enumeration receipt; never truncate candidate tails.
 */
export interface EvaluationPageAdapter<P, O> {
  prepare(
    db: Database,
    targets: readonly EvaluationPageTarget[],
  ): Promise<EvaluationPagePreparation<P>[]>;
  evaluate(
    db: Database,
    prepared: Extract<EvaluationPagePreparation<P>, { kind: "ready" }>,
    usage: AiRunContext,
  ): Promise<O>;
  publish(
    tx: Database,
    outcomes: readonly EvaluationPageOutcome<O>[],
  ): Promise<EvaluationPagePublication[]>;
  /** AI usage attribution for evaluate's shared decision wave. */
  readonly operation: string;
  /** Targets evaluated at once; defaults to the decision wave's bound. */
  readonly concurrency?: number;
  /**
   * Publication cost of one outcome, so a chunk's transaction stays bounded
   * when outcomes carry many writes. Chunks fill to 25 targets or 25 weight.
   */
  weight?(outcome: EvaluationPageOutcome<O>): number;
}
