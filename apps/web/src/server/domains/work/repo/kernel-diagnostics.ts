import {
  workDiagnostics,
  type workRetryTarget,
} from "@cubby/schemas/work-status";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { MAX_SCOPE_ATTEMPTS } from "~/server/kernel/claim";
import { isoText } from "~/server/kernel/sql-time";
import { ASK } from "~/server/kernel/vocab";

/** All queues share the same member diagnostics, including work with no record gap. */
export async function readKernelDiagnostics(db: Database) {
  const q = repositoryQueries(db);
  const rows = sql`SELECT ${"scope"}::text AS type, "scopeKind" AS kind, "scopeKey" AS key,
      NULL::uuid AS id, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts,
      ${MAX_SCOPE_ATTEMPTS}::int AS max, "lastError", false AS unknown
    FROM "ScopeDirty"
    UNION ALL SELECT ${"ask"}, feature, "inputHash", id, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts, "maxAttempts", "lastError", state=${ASK.unknown}
    FROM "Ask" WHERE state<>${ASK.answered} AND "cancelledAt" IS NULL
    UNION ALL SELECT ${"pass"}, name, key, NULL::uuid, "availableAt", "createdAt", "updatedAt", "claimToken", "claimDeadline", attempts, "maxAttempts", "lastError", false
    FROM "Pass" WHERE "doneAt" IS NULL AND "cancelledAt" IS NULL`;
  const [groups, failures] = await Promise.all([
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
      coalesce("lastError", ${"Execution outcome is unknown"}) AS error, ${isoText(sql`"updatedAt"`)} AS at
      FROM work WHERE attempts>=max OR unknown ORDER BY "updatedAt" LIMIT 100`),
  ]);
  return workDiagnostics.parse({
    groups: groups.rows,
    failures: failures.rows,
  });
}

/** One atomic refusal fence: completed or actively claimed work cannot be reset. */
export async function retryKernelWork(
  db: Database,
  target: z.infer<typeof workRetryTarget>,
) {
  const q = repositoryQueries(db);
  const common = sql`attempts=0, "availableAt"=now(), "lastError"=NULL, "waitCause"=NULL,
    "claimToken"=NULL, "claimDeadline"=NULL, "updatedAt"=now()`;
  const free = sql`("claimToken" IS NULL OR "claimDeadline"<=now())`;
  const result =
    target.type === "scope"
      ? await q.execute<{ retried: number }>(
          sql`UPDATE "ScopeDirty" SET ${common} WHERE "scopeKind"=${target.kind} AND "scopeKey"=${target.key} AND attempts>=${MAX_SCOPE_ATTEMPTS} AND ${free} RETURNING 1`,
        )
      : target.type === "ask"
        ? await q.execute<{ retried: number }>(
            sql`UPDATE "Ask" SET ${common}, state=${ASK.queued} WHERE id=${target.id}::uuid AND "cancelledAt" IS NULL AND (attempts>="maxAttempts" OR state=${ASK.unknown}) AND state<>${ASK.answered} AND ${free} RETURNING 1`,
          )
        : await q.execute<{ retried: number }>(
            sql`UPDATE "Pass" SET ${common} WHERE name=${target.kind} AND key=${target.key} AND attempts>="maxAttempts" AND "doneAt" IS NULL AND "cancelledAt" IS NULL AND ${free} RETURNING 1`,
          );
  return { retried: result.rows.length > 0 };
}
