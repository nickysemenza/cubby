import { runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";

/** Run and Image job states that wait on a person, a device or a connection. */
const waitingStateFor = (state: SQL) =>
  sql`${state} IN (${runStatus.enum.paused}, 'paused_auth', 'paused_offline', 'paused_approval', 'waiting_for_device')`;
const reviewStateFor = (state: SQL) => sql`${state} = 'needs_review'`;
const failedStateFor = (state: SQL) =>
  sql`${state} IN ('failed', 'dispatch_failed')`;

/** The states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`(${waitingStateFor(state)} OR ${reviewStateFor(state)} OR ${failedStateFor(state)})`;
