import { derivedRefreshFamily } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";
import { enqueueJob, repeatJob } from "~/server/generic/jobs/repo/jobs";

/** The manifest's `derived_refresh` steps are the families. */
export const refreshFamily = derivedRefreshFamily;
export const refreshFamilyInput = z.object({ family: refreshFamily });
export type RefreshFamily = z.infer<typeof refreshFamily>;
export const REFRESH_INTERVAL_MS = 2 * 60_000;
export const REFRESH_PAGE_SIZE = 25;

export async function lockRefreshFamily(
  db: RepositoryQueryInput,
  family: RefreshFamily,
) {
  const saved = await enqueueJob(db, {
    key: `refresh:${family}`,
    kind: "refresh.family",
    input: { family },
  });
  await repositoryQueries(db)
    .select({ id: job.id })
    .from(job)
    .where(eq(job.id, saved.id))
    .for("update");
}

/** Every edit captures a broad pass in its own transaction. No dependency graph is scheduled. */
export async function scheduleRefreshFamilies(
  db: RepositoryQueryInput,
  options: { invalidate: boolean },
) {
  for (const family of refreshFamily.options) {
    const input = {
      key: `refresh:${family}`,
      kind: "refresh.family",
      input: { family },
    };
    if (options.invalidate)
      await enqueueJob(db, { ...input, invalidate: true });
    else await repeatJob(db, input, REFRESH_INTERVAL_MS);
  }
}
