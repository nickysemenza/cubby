import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobLane,
  jobState,
} from "@cubby/schemas/job";
import { jobFilters, type JobFilters } from "@cubby/schemas/job-entity";
import { notInArray, sql } from "drizzle-orm";

import { job } from "~/server/db/retained-tables";
import {
  INTERNAL_JOB_KINDS,
  JOB_KIND_POLICY,
} from "~/server/generic/jobs/kind-policy";
import type { JobRow } from "~/server/generic/jobs/repo/job-reads";
import { jobWaitingOnReasonSql } from "~/server/generic/jobs/repo/waiting-on";
import { listReadValue } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListReadOptions } from "~/server/generic/list/repo/list-projection";
/** The Job list's population and derived SQL, shared with the Job repository. */
const jobScaffoldOptions = {
  populationFilters: ["includeInternal"],
  population: (filters) =>
    jobFilters.parse(filters).includeInternal
      ? sql`true`
      : notInArray(job.kind, INTERNAL_JOB_KINDS),
  derived: {
    lane: listReadValue(
      () =>
        sql`CASE ${sql.join(
          Object.entries(JOB_KIND_POLICY).map(
            ([kind, policy]) =>
              sql`WHEN ${job.kind} = ${kind} THEN ${policy.lane}`,
          ),
          sql` `,
        )} ELSE ${jobLane.enum.server} END`,
    ),
    reason: listReadValue(() => jobWaitingOnReasonSql()),
    needsAttention: listReadValue(
      () =>
        sql`(${job.state} = ${jobState.enum.failed} OR ${job.attempts} >= ${JOB_NEEDS_ATTENTION_ATTEMPTS})`,
    ),
    // This option controls population above; it is not a property of a Job.
    includeInternal: listReadValue(() => sql`true`),
  },
} satisfies Parameters<typeof listScaffold<"job", typeof job>>[2];
const scaffold = listScaffold("job", job, jobScaffoldOptions);

export const jobEntityWhere = (filters: JobFilters) => scaffold.where(filters);

/** The Job repository's list scaffold, with its read bindings. */
export const jobListScaffold = <Read extends ListReadOptions<JobRow>>(
  read: Read,
) => listScaffold("job", job, { ...jobScaffoldOptions, read });
