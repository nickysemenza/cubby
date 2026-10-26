export type BacklogSample = { at: number; total: number };

const MINUTE = 60_000;

/** View-local observations reset after a gap; hidden-tab time is not measured work. */
export function sampleBacklog(
  samples: readonly BacklogSample[],
  sample: BacklogSample,
): readonly BacklogSample[] {
  const last = samples.at(-1);
  if (!last || sample.at - last.at > MINUTE || sample.total === 0)
    return [sample];
  if (sample.at - last.at < 15_000) return samples;
  return [...samples.filter((row) => sample.at - row.at <= 5 * MINUTE), sample];
}

/** Net depletion includes new fanout work; processed-value counts do not. */
export function backlogEstimate(samples: readonly BacklogSample[]) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.total === 0 || last.at - first.at < MINUTE)
    return null;
  const recent = samples.find((row) => last.at - row.at <= MINUTE);
  if (!recent || recent.total <= last.total || first.total <= last.total)
    return null;
  const perMinute =
    ((first.total - last.total) * MINUTE) / (last.at - first.at);
  return { perMinute, seconds: (last.total / perMinute) * 60 };
}
