import type { JobWaitingOnReason, RunWaitGroup } from "@cubby/schemas/job";
/**
 * A Run's execution as the kernel's `run.execute` Pass (ADR 0029 section 7):
 * one Pass row per step-ledger or AI-work Run, keyed by the Run's id. These
 * reads expose that row to Run surfaces (status, wait, progress); the Pass
 * itself is declared in `workflows/runs/run-pass.ts`. Mail discovery still
 * uses the same Pass claim and retains its provider-page checkpoint.
 */
import { askState, kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import {
  isExecutedRunPurpose,
  type ExecutedRunPurpose,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import { runCause, runTrigger, runPurpose } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { textArrayParam } from "~/server/db/helpers/array-param";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

export const RUN_EXECUTE_PASS = "run.execute";

/** Executed kinds the `run.execute` Pass runs: the step ledger and AI work. */
export type PassRunPurpose = ExecutedRunPurpose;
export const isPassRunPurpose = (
  purpose: RunPurpose | string,
): purpose is PassRunPurpose => isExecutedRunPurpose(purpose);

/** The Pass cursor: which Run, of which kind, under which execution generation. */
export const runPassCursor = z.object({
  runId: z.uuid(),
  purpose: z.string(),
  generation: z.number().int().positive(),
  page: z.json().optional(),
});
export type RunPassCursor = z.infer<typeof runPassCursor>;

/** Where a Run's Pass stands; `null` when the Run has no Pass row. */
export type RunPassState = {
  runId: string;
  generation: number | null;
  /** `working` while a claim is live; `stuck` once attempts are spent. */
  state: "due" | "waiting" | "working" | "done" | "cancelled" | "stuck";
  availableAt: Date;
  waitCause: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  claimDeadline: Date | null;
  updatedAt: Date;
  medianPageMs: number | null;
};

type PassRow = {
  runId: string;
  cursor: unknown;
  availableAt: string;
  waitCause: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  claimDeadline: string | null;
  updatedAt: string;
  medianPageMs: number | null;
  done: boolean;
  cancelled: boolean;
  working: boolean;
  due: boolean;
};

const iso = (column: string) =>
  sql.raw(`to_char("${column}", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** The `run.execute` Pass rows of `runIds`, keyed by Run id. */
export async function readRunPasses(
  db: RepositoryQueryInput,
  runIds: readonly string[],
): Promise<Map<string, RunPassState>> {
  if (!runIds.length) return new Map();
  const result = await repositoryQueries(db).execute<PassRow>(sql`
    SELECT key AS "runId", cursor, ${iso("availableAt")} AS "availableAt", "waitCause",
      attempts, "maxAttempts", "lastError",
      (SELECT CASE WHEN count(*) >= 3 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY (sample->>'ms')::float8) END
        FROM "Pass" history CROSS JOIN LATERAL jsonb_array_elements(history."durationHistory") sample
        WHERE history.name = ${RUN_EXECUTE_PASS} AND (sample->>'at')::timestamptz > now() - interval '7 days') AS "medianPageMs",
      CASE WHEN "claimDeadline" IS NULL THEN NULL ELSE ${iso("claimDeadline")} END AS "claimDeadline",
      ${iso("updatedAt")} AS "updatedAt",
      "doneAt" IS NOT NULL AS done, "cancelledAt" IS NOT NULL AS cancelled,
      ("claimToken" IS NOT NULL AND "claimDeadline" > now()) AS working,
      "availableAt" <= now() AS due
    FROM "Pass"
    WHERE name = ${RUN_EXECUTE_PASS} AND key = ANY(${textArrayParam(runIds)})`);
  return new Map(
    result.rows.map((row) => {
      const cursor = runPassCursor.safeParse(row.cursor).data;
      const state: RunPassState["state"] = row.done
        ? "done"
        : row.cancelled
          ? "cancelled"
          : row.working
            ? "working"
            : row.attempts >= row.maxAttempts
              ? "stuck"
              : row.due
                ? "due"
                : "waiting";
      return [
        row.runId,
        {
          runId: row.runId,
          generation: cursor?.generation ?? null,
          state,
          availableAt: new Date(row.availableAt),
          waitCause: row.waitCause,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          lastError: row.lastError,
          claimDeadline: row.claimDeadline ? new Date(row.claimDeadline) : null,
          updatedAt: new Date(row.updatedAt),
          medianPageMs: row.medianPageMs,
        },
      ];
    }),
  );
}

export async function readRunPass(
  db: RepositoryQueryInput,
  runId: string,
): Promise<RunPassState | null> {
  return (await readRunPasses(db, [runId])).get(runId) ?? null;
}

/** SQL true while `runId`'s Pass is claimable or held: its execution is still owed. */
export const runPassOwed = (runId: SQL): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS} AND p.key = (${runId})::text
    AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p.attempts < p."maxAttempts")`;

/** SQL true while `runId`'s Pass holds a live claim: its executor is mid-page. */
export const runPassWorking = (
  runId: SQL,
): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS} AND p.key = (${runId})::text
    AND p."claimToken" IS NOT NULL AND p."claimDeadline" > now()
    AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL)`;

/** SQL true while `runId`'s Pass is due and unclaimed for longer than `stallMs`. */
export const runPassStalled = (
  runId: SQL,
  at: SQL,
  stallMs: number,
): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS} AND p.key = (${runId})::text
    AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p.attempts < p."maxAttempts"
    AND (p."claimToken" IS NULL OR p."claimDeadline" <= ${at})
    AND p."availableAt" <= ${at} - ${stallMs} * interval '1 millisecond')`;

const PASS_GROUP_REASON = {
  funding: "ai_funding_window",
  provider_capacity: "provider_capacity",
  in_flight: "provider_capacity",
  rate_limit: "rate_limit",
  device: "device",
} as const satisfies Record<string, RunWaitGroup["reason"]>;

/** The first cause name of a stored raw error (`describeErrorCauses` JSON). */
const errorClassOf = (raw: string | null) => {
  if (!raw) return null;
  try {
    const parsed = z
      .object({ causes: z.array(z.object({ name: z.string().optional() })) })
      .safeParse(JSON.parse(raw));
    return parsed.data?.causes[0]?.name ?? null;
  } catch {
    return null;
  }
};

/**
 * A Run's Pass as Run rollup facts: the waiting-on reason it counts under
 * and, while it waits, its wait group. Null once the Pass ended or stopped.
 */
export function runPassRollup(
  pass: RunPassState | undefined,
  position: { position: number; total: number } | undefined,
): {
  reason: JobWaitingOnReason;
  group: RunWaitGroup | null;
  perMinute: number | null;
} | null {
  if (!pass) return null;
  if (pass.state === "working")
    return { reason: "leased", group: null, perMinute: null };
  if (pass.state !== "due" && pass.state !== "waiting") return null;
  const cause =
    // SAFETY: the `in` check narrows the stored cause to a declared key.
    pass.waitCause && pass.waitCause in PASS_GROUP_REASON
      ? PASS_GROUP_REASON[pass.waitCause as keyof typeof PASS_GROUP_REASON]
      : null;
  const reason: JobWaitingOnReason =
    pass.state === "due"
      ? "due"
      : cause === "ai_funding_window"
        ? "waiting_funding"
        : "backing_off";
  return {
    reason,
    perMinute:
      pass.medianPageMs && pass.medianPageMs > 0
        ? 60_000 / pass.medianPageMs
        : null,
    group: {
      kind: RUN_EXECUTE_PASS,
      reason: cause ?? (pass.attempts > 0 ? "retry" : "turn"),
      mine: 1,
      position: pass.state === "due" ? (position?.position ?? null) : null,
      total: pass.state === "due" ? (position?.total ?? null) : null,
      nextAt: pass.availableAt,
      errorClass: errorClassOf(pass.lastError),
    },
  };
}

/** Each due Pass's place in the claim order (every pass name, by `availableAt`). */
export async function readDuePassPositions(
  db: RepositoryQueryInput,
  runIds: readonly string[],
): Promise<Map<string, { position: number; total: number }>> {
  if (!runIds.length) return new Map();
  const result = await repositoryQueries(db).execute<{
    key: string;
    position: number;
    total: number;
  }>(sql`
    SELECT ranked.key, ranked.position, ranked.total FROM (
      -- includes-deleted: priority follows the originating Run's member request.
      SELECT name, key, row_number() OVER (ORDER BY EXISTS (SELECT 1 FROM "Run" r WHERE r.id = "Pass"."runId" AND (r.cause = ${runCause.enum.member_request} OR r.trigger IN (${runTrigger.enum.manual}, ${runTrigger.enum.foreground}))) DESC, "availableAt", "createdAt", name, key)::int AS position,
        count(*) OVER ()::int AS total
      FROM "Pass"
      WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL AND "availableAt" <= now()
        AND attempts < "maxAttempts" AND ("claimToken" IS NULL OR "claimDeadline" <= now())
    ) ranked
    WHERE ranked.name = ${RUN_EXECUTE_PASS} AND ranked.key = ANY(${textArrayParam(runIds)})`);
  return new Map(
    result.rows.map((row) => [
      row.key,
      { position: row.position, total: row.total },
    ]),
  );
}

/** Scoped statement Sweeps yield while another page works on the same import source. */
export async function sweepPassSourceHeld(
  db: RepositoryQueryInput,
  runId: string,
): Promise<boolean> {
  const result = await repositoryQueries(db).execute<{ held: boolean }>(sql`
    WITH sweep_sources AS (
      SELECT r.id, ti.source FROM "Run" r
      JOIN "TransactionImport" ti ON ti.id = (jsonb_path_query_first(r.input,
        '$.families[*] ? (@.family == "statement_transaction").scope.importId') #>> '{}')::uuid
      WHERE r.purpose = ${runPurpose.enum.sweep} AND ${notDeleted("r")}
    ) SELECT EXISTS (
      SELECT 1 FROM sweep_sources own JOIN sweep_sources other ON other.source = own.source AND other.id <> own.id
      JOIN "Pass" p ON p.name = ${RUN_EXECUTE_PASS} AND p.key = other.id::text
      WHERE own.id = ${runId}::uuid AND p."claimToken" IS NOT NULL AND p."claimDeadline" > now()
        AND p."cancelledAt" IS NULL AND p."doneAt" IS NULL
    ) AS held`);
  return result.rows[0]?.held ?? false;
}

/** A mail admission owner must still owe this exact Run generation. */
export const runHasLivePass = (input: {
  id: SQL;
  purpose: SQL;
  generation: SQL;
  requireAttempt?: boolean;
}): SQL<boolean> => sql<boolean>`EXISTS (
 SELECT 1 FROM "Pass" p WHERE p.name = ${RUN_EXECUTE_PASS} AND p.key = (${input.id})::text
 AND p.cursor->>'purpose' = ${input.purpose} AND p.cursor->>'generation' = (${input.generation})::text
 AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p.attempts < p."maxAttempts"
 ${input.requireAttempt ? sql`AND ((p.cursor->>'generation')::int > 1 OR p.attempts > 0 OR p."claimToken" IS NOT NULL)` : sql``})`;

/** The frozen future funding deadline of a Run's kernel work, or all work when unscoped. */
export const fundingWaitUntilSql = (runId?: SQL): SQL => sql`least(
  (SELECT min(p."availableAt") FROM "Pass" p WHERE p."waitCause" = ${kernelWaitCause.enum.funding}
    AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL AND p."availableAt" > now()
    ${runId ? sql`AND p."runId" = ${runId}` : sql``}),
  (SELECT min(a."availableAt") FROM "Ask" a WHERE a.state = ${askState.enum.queued}
    AND a."waitCause" = ${kernelWaitCause.enum.funding} AND a."cancelledAt" IS NULL AND a."availableAt" > now()
    ${runId ? sql`AND EXISTS (SELECT 1 FROM "AskScope" s WHERE s."askId" = a.id AND s."runId" = ${runId})` : sql``})
)`;
