/**
 * A Run's AI summary, read from the newest live `run-summary` AiAnalysis whose
 * `result.generation` is the Run's current `endedAt`. The Run row stores
 * nothing: a restarted Run that ends again reads empty until its new
 * generation is written, and a model or prompt change never makes a second
 * summary of the same generation current.
 *
 * Kept as literal SQL over the analysis table, like the Location description
 * (`location-ai-description.ts`).
 */
import {
  RUN_SUMMARY_FEATURE_ID,
  runAiSummary,
  type RunAiSummary,
  runSummaryAnalysis,
} from "@cubby/schemas/run-fields";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";

/**
 * Runs that ended before this instant are never summarized; the summary Job
 * covers Runs reaching their end state from here on.
 */
export const RUN_SUMMARY_CUTOFF = new Date("2026-11-12T00:00:00.000Z");

/** The ISO instant a generation names, as `toISOString` writes it. */
export const runSummaryGeneration = (endedAt: Date) => endedAt.toISOString();

/** Scalar: a live summary exists for `runId`'s generation `endedAt`. */
export const runSummaryWrittenSql = (
  runId: AnyColumn | SQL,
  endedAt: AnyColumn | SQL,
): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM "ScopeState" state
  CROSS JOIN LATERAL jsonb_array_elements(state.inputs) used
  JOIN "Answer" a ON a."inputHash" = used->>'inputHash'
  LEFT JOIN "Ask" asked ON asked.id = a."askId"
  WHERE state."scopeKind" = ${"fields"} AND state."scopeKey" = ${"run:"} || ${runId}::text
    AND a.feature = ${RUN_SUMMARY_FEATURE_ID}
    AND coalesce(a.output->'value'->>${"generation"},
      (asked.input#>>'{input,request,messages,0,content}')::jsonb->>'endedAt')::timestamp
      = date_trunc('milliseconds', ${endedAt})
)`;

/** The current summary of each ended Run on a page, by Run id. */
export async function readRunAiSummaries(
  db: Parameters<typeof unwrapDb>[0],
  runs: readonly { id: string; endedAt: Date | null }[],
): Promise<Map<string, RunAiSummary>> {
  const ended = runs.filter(
    (run): run is { id: string; endedAt: Date } => run.endedAt !== null,
  );
  const summaries = new Map<string, RunAiSummary>();
  if (!ended.length) return summaries;
  const rows = await unwrapDb(db).execute<{
    entityId: string;
    model: string;
    result: unknown;
    updatedAt: Date | string;
  }>(sql`SELECT wanted.id AS "entityId", a.model,
    jsonb_build_object(${"text"}, coalesce(a.output->'value'->>${"text"}, a.output->>${"text"}),
      ${"generation"}, coalesce(a.output->'value'->>${"generation"},
        (asked.input#>>'{input,request,messages,0,content}')::jsonb->>'endedAt')) AS result,
    a."createdAt" AS "updatedAt"
    FROM unnest(${uuidArrayParam(ended.map((row) => row.id))}) AS wanted(id)
    JOIN "ScopeState" state ON state."scopeKind" = ${"fields"} AND state."scopeKey" = ${"run:"} || wanted.id::text
    CROSS JOIN LATERAL jsonb_array_elements(state.inputs) used
    JOIN "Answer" a ON a."inputHash" = used->>'inputHash'
    LEFT JOIN "Ask" asked ON asked.id = a."askId"
    WHERE a.feature = ${RUN_SUMMARY_FEATURE_ID}
    ORDER BY a."createdAt" DESC`);
  const generationOf = new Map(
    ended.map((run) => [run.id, runSummaryGeneration(run.endedAt)]),
  );
  for (const row of rows.rows) {
    if (summaries.has(row.entityId)) continue;
    const result = runSummaryAnalysis.safeParse(row.result);
    if (!result.success) continue;
    if (result.data.generation !== generationOf.get(row.entityId)) continue;
    summaries.set(
      row.entityId,
      runAiSummary.parse({
        text: result.data.text,
        model: row.model,
        writtenAt: new Date(row.updatedAt).toISOString(),
      }),
    );
  }
  return summaries;
}
