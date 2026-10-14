import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { runStatus } from "@cubby/schemas/run-fields";
import { sql, type SQL } from "drizzle-orm";

const RUN = runStatus.enum;
const JOB = imageProcessingJobState.enum;

/** Run and Image job states that wait on a person, a device or a connection. */
const waitingStateFor = (state: SQL) =>
  sql`${state} IN (${RUN.paused}, ${RUN.paused_auth}, ${RUN.paused_offline}, ${RUN.paused_approval}, ${JOB.waiting_for_device})`;
const reviewStateFor = (state: SQL) => sql`${state} = ${RUN.needs_review}`;
const failedStateFor = (state: SQL) =>
  sql`${state} IN (${RUN.failed}, ${RUN.dispatch_failed})`;

/** The states the work queue treats as needing a person. */
export const attentionStatePredicate = (state: SQL): SQL =>
  sql`(${waitingStateFor(state)} OR ${reviewStateFor(state)} OR ${failedStateFor(state)})`;
