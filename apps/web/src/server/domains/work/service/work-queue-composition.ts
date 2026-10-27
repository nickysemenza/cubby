import type { WorkQueueComposition } from "~/server/generic/work-queue/repo/work-queue";

/**
 * Every domain's work sources, composed explicitly (ADR 0019: no registry).
 * Adding a reason means adding a source in its domain and listing it here.
 */
export const workQueueComposition = (): WorkQueueComposition => ({
  sources: [],
  deferrals: [],
});
