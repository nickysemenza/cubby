import { useState } from "react";

import { sampleBacklog, type BacklogSample } from "./backlog-progress";

/** A view-local high-water mark; new work expands it, idle or a sampling gap resets it. */
export function observeBacklog(
  previous: { peak: number; samples: readonly BacklogSample[] },
  sample: BacklogSample,
) {
  const samples = sampleBacklog(previous.samples, sample);
  return {
    samples,
    peak:
      samples.length === 1
        ? sample.total
        : Math.max(previous.peak, sample.total),
  };
}

export function useBacklogProgress(total: number | undefined, at: number) {
  const [observed, setObserved] = useState(0);
  const [progress, setProgress] = useState<{
    peak: number;
    samples: readonly BacklogSample[];
  }>({ peak: 0, samples: [] });
  if (total !== undefined && at !== observed) {
    setObserved(at);
    setProgress(observeBacklog(progress, { total, at }));
  }
  return {
    ...progress,
    drained: Math.max(0, progress.peak - (total ?? progress.peak)),
  };
}
