import type { ActorContext } from "@cubby/schemas/context";
import {
  workDiagnostics,
  type workRetryTarget,
} from "@cubby/schemas/work-status";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { MAX_SCOPE_ATTEMPTS } from "~/server/kernel/claim";
import { machineryErrorText } from "~/server/kernel/error-presentation";
import { productionKernel } from "~/server/kernel/kernel";
import { isoText } from "~/server/kernel/sql-time";
import { ASK } from "~/server/kernel/vocab";

/** All queues share the same member diagnostics, including work with no record gap. */
export async function readKernelDiagnostics(
  db: Database,
  viewer: ActorContext,
) {
  const q = repositoryQueries(db);
  const rows = sql`SELECT ${"scope"}::text AS type, "scopeKind" AS kind, "scopeKey" AS key,
      NULL::uuid AS id, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts,
      ${MAX_SCOPE_ATTEMPTS}::int AS max, "lastError", false AS unknown
    FROM "ScopeDirty"
    UNION ALL SELECT ${"ask"}, feature, "inputHash", id, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts, "maxAttempts", "lastError", state=${ASK.unknown}
    FROM "Ask" WHERE state<>${ASK.answered} AND "cancelledAt" IS NULL
    UNION ALL SELECT ${"pass"}, name, key, NULL::uuid, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts, "maxAttempts", "lastError", false
    FROM "Pass" WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL`;
  const [groups, failures, finished] = await Promise.all([
    q.execute<
      z.infer<typeof workDiagnostics>["groups"][number]
    >(sql`WITH work AS (${rows}) SELECT type, kind,
      count(*) FILTER (WHERE attempts<max AND NOT unknown AND "availableAt"<=now() AND NOT coalesce("claimDeadline">now(),false))::int AS due,
      count(*) FILTER (WHERE "claimToken" IS NOT NULL AND "claimDeadline">now())::int AS claimed,
      count(*) FILTER (WHERE attempts<max AND NOT unknown AND NOT coalesce("claimDeadline">now(),false))::int AS waiting,
      count(*) FILTER (WHERE attempts>=max OR unknown)::int AS stuck,
      ${isoText(sql`min("createdAt") FILTER (WHERE attempts<max AND NOT unknown AND NOT coalesce("claimDeadline">now(),false))`)} AS "oldestWaiting"
      FROM work GROUP BY type,kind ORDER BY type,kind`),
    q.execute<
      z.infer<typeof workDiagnostics>["failures"][number]
    >(sql`WITH work AS (${rows}) SELECT
      CASE WHEN type=${"ask"} THEN jsonb_build_object('type',type,'id',id)
        ELSE jsonb_build_object('type',type,${"kind"}::text,kind,'key',key) END AS target,
      unknown, coalesce("lastError", ${"Execution outcome is unknown"}) AS error, ${isoText(sql`"updatedAt"`)} AS at
      FROM work WHERE attempts>=max OR unknown ORDER BY "updatedAt" LIMIT 100`),
    q.execute<{
      at: string | null;
    }>(sql`SELECT ${isoText(sql`max(at)`)} AS at FROM (
      SELECT "reconciledAt" AS at FROM "ScopeState"
      UNION ALL SELECT "answeredAt" FROM "Ask"
      UNION ALL SELECT "doneAt" FROM "Pass"
    ) finished`),
  ]);
  const kernel = await productionKernel();
  const safeFailures = await Promise.all(
    failures.rows.map(async (row) => {
      let error = row.error;
      let publicRecord: { entity: string; id: string } | null = null;
      let label =
        row.target.type === "scope"
          ? "Record reconciliation"
          : "Background work";
      if (row.target.type === "ask") {
        const linked = await q.execute<{
          entity: string;
          id: string;
          inputHash: string;
          feature: string;
          shortcode: string | null;
        }>(sql`
        SELECT k.entity, k."entityId" AS id, e.shortcode, a."inputHash", a.feature FROM "Ask" a
        LEFT JOIN "AskScope" s ON s."askId"=a.id
        LEFT JOIN "RecordKey" k ON k."scopeKind"=s."scopeKind" AND k."scopeKey"=s."scopeKey"
          AND k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
        LEFT JOIN "Entity" e ON e.id=k."entityId" AND e.kind=k.entity
        WHERE a.id=${row.target.id}::uuid`);
        label =
          kernel.registry.asks.get(linked.rows[0]?.feature ?? "")?.label ??
          "Answer needed";
        error = "Open the record's machinery to inspect this answer.";
        for (const record of linked.rows) {
          if (
            !record.entity ||
            !record.id ||
            !kernel.registry.machinery.has(record.entity)
          )
            continue;
          const read = await kernel.machinery(db, viewer, record);
          const ask = read.asks.find(
            (ask) => ask.inputHash === record.inputHash,
          );
          if (!ask?.lastError) {
            error = "Answer diagnostics are unavailable to this viewer.";
            break;
          }
          error = ask.lastError;
          if (record.shortcode)
            publicRecord = { entity: record.entity, id: record.shortcode };
        }
      }
      const recordRows =
        row.target.type === "scope"
          ? await q.execute<{ entity: string; id: string }>(sql`
        SELECT e.kind AS entity, e.shortcode AS id FROM "RecordKey" k JOIN "Entity" e ON e.id=k."entityId" AND e.kind=k.entity
        WHERE k."scopeKind"=${row.target.kind} AND k."scopeKey"=${row.target.key} AND k."mergedAt" IS NULL AND k."rejectedAt" IS NULL
        AND ${notDeleted("e")} AND e."mergedIntoId" IS NULL ORDER BY e.shortcode LIMIT 1`)
          : null;
      return {
        ...row,
        record: recordRows?.rows[0] ?? publicRecord,
        label,
        error: machineryErrorText(error) ?? "",
      };
    }),
  );
  return workDiagnostics.parse({
    groups: groups.rows,
    lastFinishedAt: finished.rows[0]?.at ?? null,
    failures: safeFailures,
  });
}

/** One atomic refusal fence: completed or actively claimed work cannot be reset. */
export async function retryKernelWork(
  db: Database,
  target: z.infer<typeof workRetryTarget>,
  actor: ActorContext,
) {
  const q = repositoryQueries(db);
  if (target.type === "ask") {
    const result = await q.execute<{ inputHash: string; state: string }>(
      sql`SELECT "inputHash", state FROM "Ask" WHERE id=${target.id}::uuid AND "cancelledAt" IS NULL AND state<>${ASK.answered} AND (attempts >= "maxAttempts" OR state=${ASK.unknown}) AND ("claimToken" IS NULL OR "claimDeadline"<=now())`,
    );
    const ask = result.rows[0];
    if (!ask) return { retried: false };
    const { decide } = await import("~/server/kernel/api");
    await decide(db, actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `ask:${ask.inputHash}`,
        field: "outcome",
        value: ask.state === "unknown" ? "not_sent" : "retry",
      },
    ]);
    return { retried: true };
  }
  const common = sql`attempts=0, "availableAt"=now(), "lastError"=NULL, "waitCause"=NULL,
    "claimToken"=NULL, "claimDeadline"=NULL, "updatedAt"=now()`;
  const free = sql`("claimToken" IS NULL OR "claimDeadline"<=now())`;
  const result =
    target.type === "scope"
      ? await q.execute<{ retried: number }>(
          sql`UPDATE "ScopeDirty" SET ${common} WHERE "scopeKind"=${target.kind} AND "scopeKey"=${target.key} AND attempts>=${MAX_SCOPE_ATTEMPTS} AND ${free} RETURNING 1`,
        )
      : await q.execute<{ retried: number }>(
          sql`UPDATE "Pass" SET ${common} WHERE name=${target.kind} AND key=${target.key} AND attempts>="maxAttempts" AND "doneAt" IS NULL AND "cancelledAt" IS NULL AND ${free} RETURNING 1`,
        );
  return { retried: result.rows.length > 0 };
}
