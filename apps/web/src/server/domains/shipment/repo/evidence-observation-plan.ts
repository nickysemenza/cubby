import type { shipmentObservation } from "~/server/db/schema";

type Observation = typeof shipmentObservation.$inferSelect;

/** Select a retained revision using the same ordering for replay and admission. */
export function planObservationRevision(input: {
  versions: readonly Observation[];
  current: Observation | undefined;
  fingerprint: string;
  literalFingerprint: string;
  observedAt: Date;
  revisesFromSameCapture: boolean;
}) {
  const { current, observedAt } = input;
  const matching = input.versions
    .filter(
      (version) =>
        version.fingerprint === input.fingerprint ||
        (version.event.timeBasis === undefined &&
          version.fingerprint === input.literalFingerprint),
    )
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
  const prior =
    matching.find((version) => version.firstSeenAt <= observedAt) ??
    matching.at(-1);
  const restored =
    prior?.supersededById &&
    current &&
    !current.memberReviewed &&
    observedAt >= current.lastSeenAt &&
    observedAt > prior.lastSeenAt;
  const keepCurrent =
    current &&
    (current.memberReviewed ||
      (prior && !restored) ||
      current.lastSeenAt >= observedAt);
  const canSupersede =
    !current ||
    (!current.memberReviewed &&
      (input.revisesFromSameCapture
        ? current.lastSeenAt <= observedAt
        : current.lastSeenAt < observedAt));
  return { prior, restored, keepCurrent, canSupersede };
}
