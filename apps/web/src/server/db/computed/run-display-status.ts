/**
 * What a Run reads as, in SQL: the one expression its `displayStatus` read,
 * filter, sort, grouping and list batches share. A review stop or failure
 * whose open work a live retry successor carried reads `retried` (the
 * successor holds that work; member findings stay on this Run's own
 * sections), and a stop by the AI funding window reads as waiting for funding
 * rather than review or authorization. A mail discovery pass the funding
 * window already released reads `paused` until it resumes.
 *
 * The successor probe reads `Run_predecessorRunId_idx`.
 */
import {
  runDisplayStatus,
  runPurpose,
  runStatus,
} from "@cubby/schemas/run-fields";
import { type SQL, sql } from "drizzle-orm";
import type { z } from "zod";

import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import { run } from "~/server/db/schema";

type RunDisplayStatus = z.infer<typeof runDisplayStatus>;

// An ISO-8601 UTC instant as `toISOString` writes it (`z.iso.datetime()`);
// unlike Zod it does not reject impossible calendar days such as Feb 30.
const ISO_INSTANT =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$";

/** The row's display status, branch order significant; see the module comment. */
export const runDisplayStatusSql = (): SQL<RunDisplayStatus> => {
  const status = sql`${outer(run.status)}::text`;
  const failureCode = outer(run.failureCode);
  const released = sql`${outer(run.progress)}->'fundingReleasedAt'`;
  const { needs_review, paused_auth, failed } = runStatus.enum;
  const display = runDisplayStatus.enum;
  return sql<RunDisplayStatus>`(CASE
    WHEN ${outer(run.purpose)} = ${runPurpose.enum.mail_discovery} AND ${status} = ${paused_auth}
      AND ${failureCode} = 'execution_limit'
      AND jsonb_typeof(${released}) = 'string' AND (${released} #>> '{}') ~ ${ISO_INSTANT}
      THEN ${display.paused}::text
    WHEN ${failureCode} = 'execution_limit' AND ${status} IN (${needs_review}, ${paused_auth})
      THEN ${display.waiting_for_funding}::text
    WHEN ${status} IN (${needs_review}, ${failed}) AND EXISTS (
      SELECT 1 FROM "Run" successor
      WHERE successor."predecessorRunId" = ${outer(run.id)} AND ${notDeleted("successor")})
      THEN ${display.retried}::text
    ELSE ${status} END)`;
};
