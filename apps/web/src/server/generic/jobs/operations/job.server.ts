import { jobContract } from "~/contracts/job.contract";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { listRunJobs, listSubjectJobs } from "../repo/job-diagnostics";
import { readJobQueue, readRunRollups } from "../repo/job-queue";
import { readJobLogs } from "../service/job-logs";
import { retryJobSetNow } from "../service/retry-now";

export const jobHandlers = implementOperationDomain(jobContract, {
  list: (context, input) =>
    "runId" in input
      ? listRunJobs(context.db, input.runId)
      : listSubjectJobs(context.db, input.subject),
  queue: async (context, input) =>
    readJobQueue(context.db, {
      ...input,
      runId: input.filter.runId
        ? await resolveOrThrow(context.db, "run", input.filter.runId)
        : null,
    }),
  retryNow: (context, input) =>
    retryJobSetNow(context.db, context.actorContext, input.filter),
  explain: async (context, input) =>
    (await import("~/server/workflows/job-explain")).explainWaiting(
      context.db,
      input.id,
    ),
  runRollups: async (context, input) => ({
    rollups: await readRunRollups(
      context.db,
      await Promise.all(
        input.runIds.map(async (shortcode) => ({
          id: await resolveOrThrow(context.db, "run", shortcode),
          shortcode,
        })),
      ),
    ),
  }),
  health: async (context) =>
    (await import("~/server/workflows/queue-watchdog")).readQueueHealth(
      context.db,
    ),
  logs: (context, input) => readJobLogs(context.db, input.jobId),
});
