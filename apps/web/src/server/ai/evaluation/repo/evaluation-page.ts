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

/** Admission bounds retained evidence; a wave limits unadmitted canonical reads. */
const PREPARATION_WAVE = 8;
const PAGE_EVIDENCE_BYTES = 4 * 1024 * 1024;

type PreparedEvaluationEvidence<P> = {
  ready: Extract<EvaluationPagePreparation<P>, { kind: "ready" }>[];
  failures: Map<string, unknown>;
  oversized: Map<string, string>;
  overflow: string[];
  preparedBytes: number;
};

/** Preserve the ordered byte prefix without capturing every unadmitted source. */
export async function prepareEvaluationEvidence<P>(
  db: Database,
  targets: readonly EvaluationPageTarget[],
  adapter: Pick<EvaluationPageAdapter<P, unknown>, "prepare">,
): Promise<PreparedEvaluationEvidence<P>> {
  const ready: PreparedEvaluationEvidence<P>["ready"] = [];
  const failures = new Map<string, unknown>();
  const oversized = new Map<string, string>();
  const overflow: string[] = [];
  let preparedBytes = 0;
  let full = false;
  for (let start = 0; start < targets.length; start += PREPARATION_WAVE) {
    const wave = targets.slice(start, start + PREPARATION_WAVE);
    const prepared = await adapter.prepare(db, wave);
    const expected = new Set(wave.map((entry) => entry.evaluation.id));
    if (
      prepared.length !== wave.length ||
      new Set(prepared.map((entry) => entry.target.evaluation.id)).size !==
        wave.length ||
      prepared.some((entry) => !expected.has(entry.target.evaluation.id))
    )
      throw new Error("AI page adapter returned an unexpected preparation set");
    for (const entry of prepared) {
      if (entry.kind === "failed") {
        failures.set(entry.target.evaluation.id, entry.error);
        continue;
      }
      const bytes = new TextEncoder().encode(
        JSON.stringify(
          [entry.prepared, entry.target.evaluation.snapshot],
          (_key, value) => (value instanceof Map ? [...value] : value),
        ),
      ).byteLength;
      if (bytes > PAGE_EVIDENCE_BYTES) {
        oversized.set(
          entry.target.evaluation.id,
          "AI evaluation evidence exceeds the 4 MiB page bound",
        );
        continue;
      }
      full ||= preparedBytes + bytes > PAGE_EVIDENCE_BYTES;
      if (full) {
        overflow.push(entry.target.evaluation.id);
        continue;
      }
      preparedBytes += bytes;
      ready.push(entry);
    }
    if (full) {
      overflow.push(
        ...targets
          .slice(start + wave.length)
          .map((entry) => entry.evaluation.id),
      );
      break;
    }
  }
  return { ready, failures, oversized, overflow, preparedBytes };
}

/** A paged feature's evaluated page, published in the drain's fenced chunks. */
export type PreparedEvaluationPage = {
  /** Targets with an evaluated outcome and their publication weight. */
  ready: Map<string, { target: EvaluationPageTarget; weight: number }>;
  /** Business writes for guarded targets; one validity/receipt per target. */
  publish(
    tx: Database,
    ids: readonly string[],
  ): Promise<EvaluationPagePublication[]>;
  /** Per-target errors for the drain's failure mapping. */
  failures: Map<string, unknown>;
  /** Evidence over the per-target bound can never fit a page. */
  oversized: Map<string, string>;
  /** Targets past this page's evidence budget stay due for the next page. */
  overflow: string[];
};
