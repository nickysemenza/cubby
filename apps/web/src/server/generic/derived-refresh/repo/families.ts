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

/** Explicit projection dependencies reuse the same durable family Job. */
export async function invalidateRefreshFamily(
  db: RepositoryQueryInput,
  family: RefreshFamily,
) {
  if (family === "quality") {
    // A full quality pass outlasts the gap between household writes. Restarting
    // it on each write superseded every page, so production never published.
    // A pass in progress (running, or queued between pages with a cursor)
    // finishes, and its scheduled repeat covers this change.
    const [current] = await repositoryQueries(db)
      .select({ state: job.state, cursor: job.cursor })
      .from(job)
      .where(eq(job.key, `refresh:${family}`));
    if (current?.state === "running" || current?.cursor != null) return;
  }
  await enqueueJob(db, {
    key: `refresh:${family}`,
    kind: "refresh.family",
    input: { family },
    invalidate: true,
  });
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
    if (options.invalidate) await invalidateRefreshFamily(db, family);
    else await repeatJob(db, input, REFRESH_INTERVAL_MS);
  }
}
