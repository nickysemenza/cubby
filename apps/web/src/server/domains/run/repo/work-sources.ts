import { photoGroupProposalState } from "@cubby/schemas/photo-import-run";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { householdDaySql } from "~/server/db/helpers/query";
import { related, outer } from "~/server/db/helpers/related";
import { run, run as runTable } from "~/server/db/schema";
import { activeFindingSql } from "~/server/domains/purchase-import/repo/finding-expiry";
import { attentionStatePredicate } from "~/server/domains/run/repo/work-attention";
import { workRunReviewRead } from "~/server/domains/run/repo/work-owners";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
import {
  isStepRunPurpose,
  EXECUTED_RUN_PURPOSES,
} from "~/server/workflows/runs/contract";

const execution: WorkSource = {
  id: "execution:run",
  family: "execution",
  executor: "dynamic",
  entity: "run",
  link: { kind: "record" },
  reasons: [
    {
      key: "execution:run",
      label: "Authorized execution or prerequisite wait",
    },
  ],
  candidates: async (db, scope) => ({
    query: selectWorkCandidates(db, execution, {
      entity: "run",
      id: sql`"Run".shortcode`,
      name: sql`"Run".purpose || ' · ' || "Run".status`,
      owners: workRunReviewRead().owners,
      date: householdDaySql(sql`"Run"."startedAt"`),
      executor: sql`CASE WHEN "Run".status = ${runStatus.enum.running} THEN ${workExecutor.enum.automatic} ELSE ${workExecutor.enum.external} END`,
      reason: execution.reasons[0]!.label,
      reasonKeys: [execution.id],
    })
      .from(workRunReviewRead().table)
      .where(
        and(
          sql`${notDeleted(alias(run, "Run"))} AND (("Run".status = ${runStatus.enum.running} AND ("Run".purpose IN (${sql.join(
            // A running maintenance pass or Sweep is not member work; its failed
            // or stalled outcomes still surface through the failure paths.
            EXECUTED_RUN_PURPOSES.filter(
              (purpose) => !isStepRunPurpose(purpose),
            ).map((purpose) => sql`${purpose}`),
            sql`, `,
          )}) OR "Run"."dispatchEventId" IS NOT NULL)) OR ("Run".status = ${runStatus.enum.needs_review} AND "Run"."failureCode" IN ('execution_limit') AND NOT ${related(
            runTable,
            (successor) =>
              sql`${successor.predecessorRunId} = ${outer(runTable.id)}`,
            // The work moved even to a deleted successor.
            { includeDeleted: true },
          ).exists()}))`,
          recordScope(scope, sql`"Run".shortcode`),
        ),
      ),
  }),
};
const account: WorkSource = {
  id: "account:run",
  family: "account",
  executor: "dynamic",
  entity: "run",
  link: { kind: "record" },
  reasons: [{ key: "account:run", label: "Run needs attention" }],
  candidates: async (db, scope) => ({
    query: selectWorkCandidates(db, account, {
      entity: "run",
      id: sql`"Run".shortcode`,
      name: sql`"Run".purpose || ' · ' || "Run".status`,
      owners: workRunReviewRead().owners,
      date: householdDaySql(sql`"Run"."startedAt"`),
      executor: sql`CASE WHEN "Run".status IN (${runStatus.enum.paused}, ${runStatus.enum.paused_auth}, ${runStatus.enum.paused_offline}) THEN ${workExecutor.enum.external} ELSE ${workExecutor.enum.human} END`,
      reason: account.reasons[0]!.label,
      reasonKeys: [account.id],
    })
      .from(workRunReviewRead().table)
      .where(
        and(
          sql`${notDeleted(alias(run, "Run"))} AND "Run"."failureCode" IS DISTINCT FROM 'user_cancelled' AND "Run"."failureCode" IS DISTINCT FROM 'dispatch_aborted' AND (
        (${attentionStatePredicate(sql`"Run".status`)} AND NOT ("Run".status = ${runStatus.enum.needs_review} AND "Run"."failureCode" IS NOT DISTINCT FROM 'execution_limit')
          AND NOT EXISTS (SELECT 1 FROM "AssessmentState" finding WHERE finding."runId" = "Run".id AND ${activeFindingSql("finding")}))
        OR ("Run".purpose = ${runPurpose.enum.photo_inventory} AND EXISTS (
          SELECT 1 FROM "PhotoGroupProposal" proposal WHERE proposal."runId" = "Run".id AND proposal.state = ${photoGroupProposalState.enum.proposed}
        ))
      )`,
          recordScope(scope, sql`"Run".shortcode`),
        ),
      ),
  }),
};
export const runWorkSources = [execution, account];
