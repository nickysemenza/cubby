import { jobContract } from "~/contracts/job.contract";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { listRunJobs, listSubjectJobs } from "../repo/job-diagnostics";
import { readJobLogs } from "../service/job-logs";

export const jobHandlers = implementOperationDomain(jobContract, {
  list: (context, input) =>
    "runId" in input
      ? listRunJobs(context.db, input.runId)
      : listSubjectJobs(context.db, input.subject),
  logs: (context, input) => readJobLogs(context.db, input.jobId),
});
