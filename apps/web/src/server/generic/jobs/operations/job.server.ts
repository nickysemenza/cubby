import type { SchedulerSnapshot } from "@cubby/schemas/job-scheduler";

import type { JobQueueOut } from "~/contracts/job.contract";
import { jobContract } from "~/contracts/job.contract";
import { readDeviceBacklog } from "~/server/domains/image-processing/repo/device-backlog";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { listRunJobs, listSubjectJobs } from "../repo/job-diagnostics";
import { readJobQueue, readRunRollups } from "../repo/job-queue";
import { readWorkActivity } from "../repo/work-activity";
import { readJobLogs } from "../service/job-logs";
import { retryJobSetNow } from "../service/retry-now";

export const jobHandlers = implementOperationDomain(jobContract, {
  schedule: async (context) => {
    const { jobScheduler } =
      await import("~/server/generic/jobs/scheduler/client");
    const scheduler = jobScheduler();
    if (!scheduler) throw new Error("Job scheduler binding is unavailable");
    const [snapshot, queue]: [SchedulerSnapshot, JobQueueOut] =
      await Promise.all([
        scheduler.snapshot(),
        readJobQueue(context.db, {
          filter: {},
          pageIndex: 0,
          pageSize: 1,
          runId: null,
        }),
      ]);
    const running = queue.counts
      .filter((row) => row.reason === "leased")
      .reduce((total, row) => total + row.count, 0);
    return {
      ...snapshot,
      readAt: new Date().toISOString(),
      running,
      waiting: queue.total - running,
    };
  },
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
  deviceBacklog: (context) => readDeviceBacklog(context.db),
  activity: (context) => readWorkActivity(context.db),
  logs: (context, input) => readJobLogs(context.db, input.jobId),
});
