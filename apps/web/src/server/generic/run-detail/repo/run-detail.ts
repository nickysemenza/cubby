import type { AssessmentFamily } from "@cubby/schemas/assessment";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  RUN_DECISION_LIMIT,
  runDecisionStatus,
  type RunDecisionsOut,
  type RunDetailStepsOut,
} from "~/contracts/run-detail.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, run } from "~/server/db/schema";
import { readRunSteps } from "~/server/domains/run/repo/run-step";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** A Run's stored steps in order, with raw meta for the view model to read. */
export async function readRunDetailSteps(
  db: Database,
  code: string,
): Promise<RunDetailStepsOut> {
  const runId = await resolveOrThrow(db, "run", code);
  const [owner, steps] = await Promise.all([
    getDb(db)
      .select({ purpose: run.purpose, status: run.status })
      .from(run)
      .where(eq(run.id, runId)),
    readRunSteps(db, runId),
  ]);
  if (!owner[0]) throw new Error(`Run ${code} does not exist`);
  return {
    ...owner[0],
    steps: steps.map((step) => ({
      key: step.key,
      label: step.label,
      position: step.position,
      state: step.state,
      found: step.found,
      done: step.done,
      failed: step.failed,
      skipped: step.skipped,
      left: step.left,
      pages: step.pages,
      pausedReason: step.pausedReason,
      pausedUntil: iso(step.pausedUntil),
      startedAt: iso(step.startedAt),
      endedAt: iso(step.endedAt),
      errors: step.errors,
      meta: step.meta ?? null,
    })),
  };
}

/**
 * The Assessments a Run published in one family, newest first: every
 * candidate, blocked ones included, with its stored judgment and status.
 */
export async function readRunDecisions(
  db: Database,
  code: string,
  family: AssessmentFamily,
): Promise<RunDecisionsOut> {
  const runId = await resolveOrThrow(db, "run", code);
  const scope = and(
    eq(assessmentState.runId, runId),
    eq(assessmentState.family, family),
  );
  const [rows, [total]] = await Promise.all([
    getDb(db)
      .select({
        id: assessment.id,
        family: assessmentState.family,
        status: assessmentState.status,
        active: assessmentState.active,
        judgment: assessment.judgment,
        producer: assessment.producer,
        createdAt: assessment.createdAt,
        updatedAt: assessmentState.updatedAt,
      })
      .from(assessmentState)
      .innerJoin(assessment, eq(assessment.id, assessmentState.id))
      .where(scope)
      .orderBy(desc(assessment.createdAt), desc(assessment.id))
      .limit(RUN_DECISION_LIMIT),
    getDb(db).select({ value: count() }).from(assessmentState).where(scope),
  ]);
  return {
    rows: rows.map((row) => ({
      ...row,
      status: runDecisionStatus.parse(row.status),
      judgment: z.json().parse(row.judgment),
      producer: row.producer
        ? {
            kind: row.producer.kind,
            model: row.producer.model,
            revision: row.producer.revision,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total: total?.value ?? 0,
  };
}
