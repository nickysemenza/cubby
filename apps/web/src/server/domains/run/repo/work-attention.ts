import { runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";

const RUN = runStatus.enum;

/** Run states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`${state} IN (${RUN.paused}, ${RUN.paused_auth}, ${RUN.paused_offline}, ${RUN.needs_review}, ${RUN.failed}, ${RUN.dispatch_failed})`;

/** Permanent coordinator retirement closes execution recovery, not source review. */
export const retiredRunPredicate = (retiredAt: SQL): SQL<boolean> =>
  sql<boolean>`${retiredAt} IS NOT NULL`;

/** Explicit member stops remain in history without requesting recovery. */
export const memberStoppedRunPredicate = (failureCode: SQL): SQL<boolean> =>
  sql<boolean>`(${failureCode} IS NOT DISTINCT FROM ${"user_cancelled"} OR ${failureCode} IS NOT DISTINCT FROM ${"dispatch_aborted"})`;
