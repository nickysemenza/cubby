import { emailImportOutcome } from "@cubby/schemas/email-fields";
import { runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";

const OUTCOME = emailImportOutcome.enum;
/** Accepted source evidence wins over the current import Run's progress. */
const emailImportOutcomeSql = (accepted: SQL): SQL<string | null> => sql`CASE
  WHEN ${accepted} IS TRUE THEN ${OUTCOME.imported}::text
  WHEN "Email"."runId" IS NULL THEN CASE WHEN ${accepted} IS FALSE THEN ${OUTCOME.not_imported}::text ELSE NULL END
  ELSE (SELECT CASE
    WHEN r."status" IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) THEN ${OUTCOME.failed}::text
    WHEN r."status" = ${runStatus.enum.completed} THEN CASE WHEN ${accepted} IS FALSE THEN ${OUTCOME.not_imported}::text ELSE NULL END
    ELSE ${OUTCOME.importing}::text END
    FROM "Run" r WHERE r.id = "Email"."runId")
END`;

/** Run progress remains known without facts; only published evidence can settle import completion. */
export async function loadEmailImportOutcomes(
  db: RepositoryQueryInput,
  rows: readonly { id: string; accepted: boolean | null }[],
): Promise<Map<string, z.output<typeof emailImportOutcome>>> {
  if (rows.length === 0) return new Map();
  const result = await unwrapDb(db).execute(sql`
    SELECT "Email".id, ${emailImportOutcomeSql(sql`accepted.accepted`)} AS outcome
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS accepted(id uuid, accepted boolean)
    JOIN "Email" ON "Email".id = accepted.id`);
  const parsed = z
    .array(z.object({ id: z.string(), outcome: emailImportOutcome.nullable() }))
    .parse(result.rows);
  const outcomes = new Map<string, z.output<typeof emailImportOutcome>>();
  for (const row of parsed)
    if (row.outcome !== null) outcomes.set(row.id, row.outcome);
  return outcomes;
}
