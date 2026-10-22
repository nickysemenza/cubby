import { suggestionStatus } from "@cubby/schemas/ai";
import { feedbackAuthority, runFindingEntity } from "@cubby/schemas/assessment";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, getDb } from "~/server/db/helpers";
import { assessment, assessmentState, ledgerParty } from "~/server/db/schema";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";

/**
 * Import findings are `run_finding` Assessments. The current row's `data`
 * carries what reads list; the Assessment keeps the original judgment.
 */
export const runFindingData = z
  .object({
    kind: z.string().min(1),
    summary: z.string(),
    proposedFix: z.json().nullable(),
    probability: z.number().nullable(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .passthrough();

export type RunFindingPublication = {
  runId: string | null;
  ledgerPartyId: string;
  entityKind: z.infer<typeof runFindingEntity>;
  entityId: string;
  kind: string;
  summary: string;
  proposedFix: z.infer<ReturnType<typeof z.json>> | null;
  evidenceFingerprint: string;
  probability?: number | null;
  expiresAt?: Date | null;
  /** The import applied the fix itself; recorded as automatic Feedback. */
  autoApplied?: boolean;
};

const laterDeadline = (current: string | null, next: string | null) =>
  current === null || next === null
    ? null
    : new Date(next) > new Date(current)
      ? next
      : current;

/**
 * One finding per member, record, kind and evidence. The same evidence found
 * again keeps a resolved finding resolved and extends an open one's deadline
 * through a system projection event; it never opens a second finding.
 */
export async function publishRunFinding(
  db: Database | DrizzleTransaction,
  input: RunFindingPublication,
): Promise<{ id: string; created: boolean; open: boolean }> {
  const database = "select" in db ? databaseForTransaction(db) : db;
  const publicationKey = [
    "run_finding:v1",
    input.ledgerPartyId,
    input.entityKind,
    input.entityId,
    input.kind,
    input.evidenceFingerprint,
  ].join(":");
  const data = runFindingData.parse({
    kind: input.kind,
    summary: input.summary,
    proposedFix: input.proposedFix,
    probability: input.probability ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null,
  });
  const [existing] = await getDb(database)
    .select({ id: assessment.id })
    .from(assessment)
    .where(eq(assessment.publicationKey, publicationKey))
    .limit(1);
  if (existing) {
    const extended = await transitionAssessmentStates(
      database,
      and(
        eq(assessmentState.id, existing.id),
        eq(assessmentState.active, true),
        eq(assessmentState.status, "pending"),
      ),
      (row) => {
        const current = runFindingData.parse(row.data);
        const expiresAt = laterDeadline(current.expiresAt, data.expiresAt);
        return expiresAt === current.expiresAt
          ? null
          : { data: { ...current, expiresAt } };
      },
      { kind: "run_finding_redetected" },
    );
    const [current] = extended.length
      ? extended
      : await getDb(database)
          .select({
            active: assessmentState.active,
            status: assessmentState.status,
          })
          .from(assessmentState)
          .where(eq(assessmentState.id, existing.id));
    return {
      id: existing.id,
      created: false,
      open: current?.active === true && current.status === status.pending,
    };
  }
  const published = await publishAssessment(
    database,
    {
      publicationKey,
      family: "run_finding",
      subject: {
        kind: "run_finding",
        entity: input.entityKind,
        recordId: input.entityId,
        ledgerPartyId: input.ledgerPartyId,
      },
      judgment: {
        kind: data.kind,
        summary: data.summary,
        proposedFix: data.proposedFix,
        probability: data.probability,
      },
      fingerprint: input.evidenceFingerprint,
      producer: input.runId
        ? {
            kind: "rule",
            model: null,
            revision: null,
            runId: input.runId,
            evaluationId: null,
          }
        : null,
      evidence: null,
    },
    {
      runId: input.runId,
      ledgerPartyId: input.ledgerPartyId,
      status: input.autoApplied ? status.applied : status.pending,
      data,
    },
  );
  if (input.autoApplied)
    await recordFeedback(database, {
      assessmentId: published.id,
      operationId: "import-applied",
      verdict: "correct",
      intent: "apply",
      authority: "automatic",
      actorUserId: null,
      receipt: { runId: input.runId },
      metadata: { kind: "run_finding_import", policy: "import" },
    });
  return { id: published.id, created: true, open: !input.autoApplied };
}

/** The status reads show: retired and rejected findings read dismissed. */
export const runFindingStatus = z.enum(["open", "applied", "dismissed"]);
const status = suggestionStatus.enum;
const findingKey = runFindingData.keyof().enum;

/** `open` while pending and current. */
export const runFindingStatusSql = sql<
  z.infer<typeof runFindingStatus>
>`CASE WHEN ${assessmentState.status} = ${status.pending} AND ${assessmentState.active} THEN ${runFindingStatus.enum.open} WHEN ${assessmentState.status} = ${status.applied} THEN ${runFindingStatus.enum.applied} ELSE ${runFindingStatus.enum.dismissed} END`;

/** The retired RunFinding row shape, read from the finding's current state. */
export const runFindingColumns = {
  id: assessmentState.id,
  runId: assessmentState.runId,
  ledgerPartyId: sql<
    typeof ledgerParty.$inferSelect.id
  >`${assessmentState.ledgerPartyId}`,
  entityKind: assessmentState.entity,
  entityId: assessmentState.recordId,
  kind: sql<string>`${assessmentState.data}->>${findingKey.kind}`,
  summary: sql<string>`${assessmentState.data}->>${findingKey.summary}`,
  proposedFix: sql<unknown>`${assessmentState.data}->${findingKey.proposedFix}`,
  probability: sql<
    number | null
  >`(${assessmentState.data}->>${findingKey.probability})::real`,
  expiresAt:
    sql<Date | null>`(${assessmentState.data}->>${findingKey.expiresAt})::timestamptz`.mapWith(
      (value: Date | string | null) =>
        value === null ? null : new Date(value),
    ),
  status: runFindingStatusSql,
  autoApplied: sql<boolean>`EXISTS (SELECT 1 FROM "Feedback" f WHERE f."assessmentId" = ${assessmentState.id} AND f.authority = ${feedbackAuthority.enum.automatic})`,
  createdAt: assessmentState.createdAt,
};

export const isRunFinding = eq(assessmentState.family, "run_finding");
