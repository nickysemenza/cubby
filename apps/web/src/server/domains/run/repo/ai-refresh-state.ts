import {
  aiProvenance,
  suggestionAcceptanceReceipt,
  type AiEvaluationTarget,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { evaluationSlotKey } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import { markAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run,
  suggestionTable as suggestion,
} from "~/server/db/schema";
import {
  type SuggestionStateRow,
  suggestionStateColumns,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";

import { tryLockAiRefreshScheduling } from "./ai-refresh-admission";
import { readAutomaticAiStop } from "./automatic-ai-stop";

export type { SuggestionStateRow };
const jsonSnapshot = (value: unknown) =>
  z.json().parse(JSON.parse(JSON.stringify(value)));

type EvaluationTargetInput = {
  target: AiEvaluationTarget;
  provenance: AiProvenance;
  snapshot: unknown;
  blockedReason?: string;
};

const targetWorkKey = ({ target, provenance }: EvaluationTargetInput) =>
  sha256Hex(
    JSON.stringify({
      slotKey: evaluationSlotKey({ feature: targetFeature(target), target }),
      provenance: { ...provenance, model: null },
    }),
  );

// Persistently declined input gets a bounded number of automatic attempts.
const MAX_REOPENS = 3;
/** failureCode of a Run whose queued work was cleared as redundant, not refused. */
const SUPERSEDED_RUN_FAILURE = "superseded";

const targetFeature = (target: AiEvaluationTarget) =>
  target.kind === "field" ? "field-suggestion" : "mailbox-triage";

async function slotAdmissions(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  if (!targets.length) return [];
  const unique = [
    ...new Map(
      targets.map((item) => [
        evaluationSlotKey({
          feature: targetFeature(item.target),
          target: item.target,
        }),
        item,
      ]),
    ).entries(),
  ];
  const history = await getDb(db)
    .select({ item: aiEvaluation, failureCode: run.failureCode })
    .from(aiEvaluation)
    .leftJoin(run, eq(run.id, aiEvaluation.runId))
    .where(
      and(
        eq(aiEvaluation.executionKind, "ai_refresh"),
        inArray(
          aiEvaluation.slotKey,
          unique.map(([key]) => key),
        ),
      ),
    )
    .orderBy(desc(aiEvaluation.createdAt), desc(aiEvaluation.id));
  return unique.map(([slotKey, input]) => {
    const rows = history
      .filter((row) => row.item.slotKey === slotKey)
      .map((row) => ({
        ...row,
        sameInput:
          JSON.stringify(
            aiProvenance.omit({ model: true }).parse(row.item.provenance),
          ) ===
          JSON.stringify(
            aiProvenance.omit({ model: true }).parse(input.provenance),
          ),
      }));
    const open = rows.find(({ item }) => item.state === "queued");
    const common = { input, slotKey, history: rows.map((row) => row.item) };
    if (open)
      return {
        ...common,
        kind:
          !open.sameInput &&
          !input.blockedReason &&
          open.failureCode !== "user_cancelled"
            ? ("update" as const)
            : ("unchanged" as const),
        row: open.item,
      };
    const same = rows.filter((row) => row.sameInput);
    const declined = (row: (typeof rows)[number]) =>
      row.item.state === "blocked" ||
      row.item.state === "obsolete" ||
      (row.item.state === "cancelled" &&
        row.failureCode === SUPERSEDED_RUN_FAILURE);
    const unchanged =
      same[0]?.failureCode === "user_cancelled" ||
      same.some(({ item }) => item.state === "result_ready") ||
      same.filter(declined).length >= MAX_REOPENS ||
      (rows[0]?.sameInput && (input.blockedReason || !declined(rows[0])));
    return {
      ...common,
      kind: unchanged ? ("unchanged" as const) : ("insert" as const),
      row: undefined,
    };
  });
}

/** Whether any logical slot admits current input, using one history read. */
async function hasAdmissibleTarget(
  db: Database,
  targets: readonly EvaluationTargetInput[],
) {
  return (await slotAdmissions(db, targets)).some(
    (entry) => entry.kind !== "unchanged",
  );
}

/** Admit/update a finite slot set with one history read and set-based writes. */
export async function insertEvaluationTargets(
  db: Database,
  runId: string | null,
  targets: readonly EvaluationTargetInput[],
  options: { updatesOnly?: boolean } = {},
) {
  if (!targets.length) return 0;
  const keys = [
    ...new Set(
      targets.map((item) =>
        evaluationSlotKey({
          feature: targetFeature(item.target),
          target: item.target,
        }),
      ),
    ),
  ].sort();
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM unnest(ARRAY[${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) key ORDER BY key`,
    );
    const admissions = (await slotAdmissions(tx, targets)).filter(
      (entry) =>
        entry.kind !== "unchanged" &&
        (!options.updatesOnly || entry.kind === "update"),
    );
    const prepared = await Promise.all(
      admissions.map(async (entry) => {
        const base = await targetWorkKey(entry.input);
        const held = new Set(
          entry.history
            .filter(
              (row) =>
                row.id !==
                (entry.kind === "update" ? entry.row?.id : undefined),
            )
            .map((row) => row.workKey),
        );
        let workKey = base;
        for (let attempt = 1; held.has(workKey); attempt++)
          workKey = `${base}:attempt:${attempt}`;
        return { ...entry, workKey };
      }),
    );
    const updates = prepared.flatMap((entry) =>
      entry.kind === "update" && entry.row
        ? [{ ...entry, row: entry.row }]
        : [],
    );
    let changed = 0;
    if (updates.length) {
      const values = sql.join(
        updates.map(
          (entry) =>
            sql`(${entry.row.id}::uuid, ${JSON.stringify(entry.input.target)}::jsonb, ${JSON.stringify(entry.input.provenance)}::jsonb, ${JSON.stringify(jsonSnapshot(entry.input.snapshot))}::jsonb, ${entry.workKey}::text)`,
        ),
        sql`, `,
      );
      const written = await getDb(tx)
        .update(aiEvaluation)
        .set({
          target: sql`page.target`,
          provenance: sql`page.provenance`,
          snapshot: sql`page.snapshot`,
          workKey: sql`page.work_key`,
          result: null,
          receipt: null,
          error: null,
          updatedAt: new Date(),
        })
        .from(
          sql`(VALUES ${values}) page(id, target, provenance, snapshot, work_key)`,
        )
        .where(
          and(
            sql`${aiEvaluation.id}=page.id`,
            eq(aiEvaluation.state, "queued"),
          ),
        )
        .returning({ id: aiEvaluation.id });
      // Re-input supersedes an attempt on the previous input.
      await markAiEvaluationWork(
        tx,
        written.map((entry) => entry.id),
      );
      if (written.length && runId)
        await getDb(tx)
          .insert(aiEvaluationRequest)
          .values(
            written.map((entry) => ({
              runId: runEntityId.parse(runId),
              evaluationId: entry.id,
            })),
          )
          .onConflictDoNothing();
      changed += written.length;
    }
    const fresh = prepared.filter((entry) => entry.kind === "insert");
    if (fresh.length) {
      const inserted = await getDb(tx)
        .insert(aiEvaluation)
        .values(
          fresh.map((entry) => ({
            runId: runId ? runEntityId.parse(runId) : null,
            executionKind: "ai_refresh" as const,
            feature: targetFeature(entry.input.target),
            workKey: entry.workKey,
            target: entry.input.target,
            provenance: entry.input.provenance,
            snapshot: jsonSnapshot(entry.input.snapshot),
            ...(entry.input.blockedReason
              ? {
                  state: "blocked" as const,
                  error: entry.input.blockedReason,
                  receipt: { reason: "mailbox_authorization_unavailable" },
                }
              : {}),
          })),
        )
        .onConflictDoNothing()
        .returning();
      if (inserted.length && runId)
        await getDb(tx)
          .insert(aiEvaluationRequest)
          .values(
            inserted.map((entry) => ({
              runId: runEntityId.parse(runId),
              evaluationId: entry.id,
            })),
          )
          .onConflictDoNothing();
      await markAiEvaluationWork(
        tx,
        inserted.map((entry) => entry.id),
      );
      changed += inserted.length;
    }
    return changed;
  });
}

/** Automatic evaluations waiting before a discovery page holds its cursor. */
const AUTOMATIC_EVALUATION_BACKLOG = 1_000;

/**
 * Admit automatic refresh work, which has no Run: the drain runs it and the activation
 * authorizes it. A full backlog defers the page, so a pass drains at the drain's pace.
 */
export async function scheduleAutomaticEvaluations(
  db: Database,
  targets: EvaluationTargetInput[],
): Promise<
  | { kind: "scheduled" | "unchanged" }
  | { kind: "deferred"; reason: "scheduling_busy" | "capacity" | "stopped" }
> {
  if (!(await hasAdmissibleTarget(db, targets))) return { kind: "unchanged" };
  return withTransactionDatabase(db, async (tx) => {
    if (!(await tryLockAiRefreshScheduling(tx)))
      return { kind: "deferred", reason: "scheduling_busy" };
    if (await readAutomaticAiStop(tx))
      return { kind: "deferred", reason: "stopped" };
    // An update keeps its slot's owner and adds no backlog.
    await insertEvaluationTargets(tx, null, targets, { updatesOnly: true });
    if (!(await hasAdmissibleTarget(tx, targets))) return { kind: "scheduled" };
    const [backlog] = await getDb(tx)
      .select({ owed: count() })
      .from(aiEvaluation)
      .where(and(isNull(aiEvaluation.runId), isNotNull(aiEvaluation.runAt)));
    if ((backlog?.owed ?? 0) >= AUTOMATIC_EVALUATION_BACKLOG)
      return { kind: "deferred", reason: "capacity" };
    return (await insertEvaluationTargets(tx, null, targets))
      ? { kind: "scheduled" }
      : { kind: "unchanged" };
  });
}

/** Settle an evaluation with no replacement without rewriting historical Feedback. */
export async function settleAppliedFieldRefresh(
  db: Database,
  id: string,
  fingerprint: string,
  provenance: AiProvenance,
) {
  await transitionSuggestionStates(
    db,
    and(eq(suggestion.id, id), eq(suggestion.family, "field")),
    (row) => {
      const receipt = suggestionAcceptanceReceipt
        .nullable()
        .parse(row.acceptanceReceipt ?? null);
      if (!receipt) return null;
      return {
        acceptanceReceipt: {
          ...receipt,
          evaluatedInput: { fingerprint, provenance },
        },
      };
    },
  );
}

export async function suggestionStatesById(
  db: Database,
  ids: readonly SuggestionStateRow["id"][],
) {
  return getDb(db)
    .select(suggestionStateColumns)
    .from(suggestion)
    .where(inArray(suggestion.id, [...ids]));
}
