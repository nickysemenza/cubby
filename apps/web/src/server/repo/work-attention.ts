import { runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";

const RUN = runStatus.enum;

/** Run states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`${state} IN (${RUN.paused}, ${RUN.paused_auth}, ${RUN.paused_offline}, ${RUN.paused_approval}, ${RUN.needs_review}, ${RUN.failed}, ${RUN.dispatch_failed})`;
