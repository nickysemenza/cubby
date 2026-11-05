import { jobShortcode } from "@cubby/schemas/identifiers";
import type { schedulerDeadline } from "@cubby/schemas/job-scheduler";
import { and, eq, inArray, or } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";

/** Ready work is delivered by queues; only future execution/recovery needs an alarm. */
export async function jobDeadlines(
  db: Database,
): Promise<z.infer<typeof schedulerDeadline>[]> {
  // Include deadlines that become due while this observation is in flight.
  const now = Date.now();
  const rows = await repositoryQueries(db)
    .select({
      shortcode: job.shortcode,
      kind: job.kind,
      state: job.state,
      availableAt: job.availableAt,
      leaseExpiresAt: job.leaseExpiresAt,
    })
    .from(job)
    .where(
      and(
        or(
          inArray(job.state, ["queued", "retry_wait"]),
          eq(job.state, "running"),
        ),
      ),
    );
  return rows
    .flatMap((row) => {
      const at = row.state === "running" ? row.leaseExpiresAt : row.availableAt;
      if (!at || at.getTime() <= now) return [];
      return [
        {
          job: jobShortcode.parse(row.shortcode),
          kind: row.kind,
          at: at.toISOString(),
          reason:
            row.state === "running"
              ? ("lease-expiry" as const)
              : ("available" as const),
        },
      ];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}
