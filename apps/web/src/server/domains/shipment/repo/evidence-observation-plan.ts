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

export function planObservationWrite(input: {
  versions: readonly Observation[];
  current: Observation | undefined;
  fingerprint: string;
  literalFingerprint: string;
  observedAt: Date;
  revisesFromSameCapture: boolean;
  event: Observation["event"];
  shipmentId: Observation["shipmentId"];
  sourceCaptureId: Observation["sourceCaptureId"];
  sourcePackageId: Observation["sourcePackageId"];
  sourceKey: string;
  occurrenceKey: string;
}) {
  const { prior, restored, canSupersede } = planObservationRevision(input);
  if (prior && !restored)
    return {
      kind: "repeat" as const,
      id: prior.id,
      firstSeenAt: new Date(
        Math.min(prior.firstSeenAt.getTime(), input.observedAt.getTime()),
      ),
      lastSeenAt: new Date(
        Math.max(prior.lastSeenAt.getTime(), input.observedAt.getTime()),
      ),
      captureId: input.sourceCaptureId,
      observedAt: input.observedAt,
    };
  return {
    kind: "insert" as const,
    values: {
      shipmentId: input.shipmentId,
      sourceCaptureId: input.sourceCaptureId,
      sourceKey: input.sourceKey,
      sourcePackageId: input.sourcePackageId,
      sourceEventKey: input.event.sourceEventKey,
      occurrenceKey: input.occurrenceKey,
      fingerprint: input.fingerprint,
      event: input.event,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      supersededById: canSupersede ? null : (input.current?.id ?? null),
    },
    canSupersede,
    captureId: input.sourceCaptureId,
    observedAt: input.observedAt,
  };
}
export type ObservationWritePlan = ReturnType<typeof planObservationWrite>;
