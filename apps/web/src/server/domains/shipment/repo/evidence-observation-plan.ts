import type { ShipmentObservationInput } from "@cubby/schemas/shipment-evidence";

import type { shipmentObservation } from "~/server/db/schema";
import { normalizeTrackingNumber } from "~/server/domains/shipment/repo/carrier-recognition";

import { canonical, canonicalDigest } from "./evidence-internal";

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

async function observationIdentity(
  observation: ShipmentObservationInput,
  occurrences: Map<string, number>,
) {
  const fingerprint = await canonicalDigest(observation);
  const { timeBasis: _timeBasis, ...literalObservation } = observation;
  const literalFingerprint = await canonicalDigest(literalObservation);
  const ordinal = occurrences.get(literalFingerprint) ?? 0;
  occurrences.set(literalFingerprint, ordinal + 1);
  return {
    fingerprint,
    literalFingerprint,
    occurrenceKey: observation.sourceEventKey
      ? `event:${observation.sourceEventKey}`
      : `content:${literalFingerprint}:${ordinal}`,
  };
}

// Without wording, carrier or place: what must agree for one source to restate an event.
const restatedEvent = (event: ShipmentObservationInput) =>
  canonical({
    kind: event.kind,
    time: event.time,
    forecast: event.timeBasis === "estimate",
    trackingNumber: normalizeTrackingNumber(event.trackingNumber ?? ""),
  });
const eventPlace = (event: ShipmentObservationInput) =>
  event.location?.trim().toLowerCase() ?? null;

/**
 * Occurrence identities for one packet, keeping stored keys and fingerprints. A keyless
 * identity hashes the submitted wording and carrier hints, so re-reading identical source
 * content under a new extraction looks like a new event. Only that same capture can revise
 * an occurrence, and only when exactly one unclaimed occurrence and one unmatched
 * observation restate each other, first apart from carrier hints and then apart from
 * wording. Anything else stays a separate event: same-day occurrences are never guessed.
 */
export async function planPacketObservationIdentities(
  /** Loaded only when a restatement match needs it; most replays never query. */
  loadSupported: () => Promise<ReadonlySet<string>>,
  observations: readonly ShipmentObservationInput[],
  history: readonly (typeof shipmentObservation.$inferSelect)[],
) {
  const occurrences = new Map<string, number>();
  const identified: (Awaited<ReturnType<typeof observationIdentity>> & {
    observation: ShipmentObservationInput;
    revisesFromSameCapture: boolean;
  })[] = [];
  for (const observation of observations)
    identified.push({
      observation,
      ...(await observationIdentity(observation, occurrences)),
      revisesFromSameCapture: false,
    });
  const known = new Set(history.map((version) => version.occurrenceKey));
  const claimed = new Set(
    identified
      .map(({ occurrenceKey }) => occurrenceKey)
      .filter((key) => known.has(key)),
  );
  const sourceVersions = history.filter(
    (version) => version.sourceEventKey === null && !version.memberReviewed,
  );
  const unmatched = () =>
    identified.filter(
      ({ observation, occurrenceKey }) =>
        observation.sourceEventKey === null && !claimed.has(occurrenceKey),
    );
  // An earlier correction already holds this wording under the original occurrence.
  for (const entry of unmatched()) {
    const revised = sourceVersions.find(
      (version) =>
        !claimed.has(version.occurrenceKey) &&
        (version.fingerprint === entry.fingerprint ||
          (version.event.timeBasis === undefined &&
            version.fingerprint === entry.literalFingerprint)),
    );
    if (!revised) continue;
    entry.occurrenceKey = revised.occurrenceKey;
    claimed.add(revised.occurrenceKey);
  }
  if (!sourceVersions.length || !unmatched().length) return identified;
  const supported = await loadSupported();
  for (const restated of [
    (event: ShipmentObservationInput) =>
      canonical([restatedEvent(event), eventPlace(event), event.rawStatus]),
    restatedEvent,
  ]) {
    const pending = unmatched();
    for (const entry of pending) {
      const key = restated(entry.observation);
      const open = new Map(
        sourceVersions
          .filter(
            (version) =>
              supported.has(version.id) &&
              !claimed.has(version.occurrenceKey) &&
              restated(version.event) === key,
          )
          .map((version) => [version.occurrenceKey, version.event]),
      );
      const [only, rival] = open.entries();
      if (
        !only ||
        rival ||
        pending.filter(
          (other) =>
            restated(other.observation) === key &&
            !claimed.has(other.occurrenceKey),
        ).length !== 1
      )
        continue;
      const [occurrenceKey, event] = only;
      const [stored, submitted] = [
        eventPlace(event),
        eventPlace(entry.observation),
      ];
      if (stored && submitted && stored !== submitted) continue;
      entry.occurrenceKey = occurrenceKey;
      entry.revisesFromSameCapture = true;
      claimed.add(occurrenceKey);
    }
  }
  return identified;
}

export function planEffectiveObservations(
  identified: Awaited<ReturnType<typeof planPacketObservationIdentities>>,
  history: readonly Observation[],
  observedAt: Date,
) {
  const effectiveObservations = [];
  for (const key of identified) {
    const { observation } = key;
    const versions = history
      .filter((version) => version.occurrenceKey === key.occurrenceKey)
      .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
    const current = versions.find((version) => !version.supersededById);
    const { keepCurrent } = planObservationRevision({
      versions,
      current,
      fingerprint: key.fingerprint,
      literalFingerprint: key.literalFingerprint,
      observedAt,
      revisesFromSameCapture: key.revisesFromSameCapture,
    });
    // Period admission uses the revision replay will retain.
    effectiveObservations.push(
      keepCurrent && current ? current.event : observation,
    );
  }
  return effectiveObservations;
}
