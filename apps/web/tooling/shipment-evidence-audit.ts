import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { mailReadOut } from "@cubby/schemas/mailbox-research";
import { vendorShortcode } from "@cubby/schemas/identifiers";
import {
  retainedShipmentEvidence,
  datedShipmentEventTime,
  shipmentTimelineOut,
  recordShipmentEvidenceOut,
} from "@cubby/schemas/shipment-evidence";
import { z } from "zod";

import { completeRetainedMail, retainedMailPages } from "./retained-mail-pages";

const emailIdentity = mailReadOut.pick({ id: true, checksum: true });
const record = z.object({
  id: z.string().min(1),
  source: emailIdentity,
  shipments: z.array(retainedShipmentEvidence).min(1),
  receipt: recordShipmentEvidenceOut,
});
const batch = z.object({
  id: z.string().min(1),
  expectedRecordIds: z.array(z.string().min(1)),
  records: z.array(record),
  /** Every retained candidate needs a verified disposition or a concrete hold. */
  dispositions: z.array(
    z.object({
      emailId: emailIdentity.shape.id,
      checksum: emailIdentity.shape.checksum,
      outcome: z.enum(["linked", "unresolved"]),
      reason: z.string().min(1),
    }),
  ),
  timelines: z.array(shipmentTimelineOut),
  beforeTimelines: z.array(shipmentTimelineOut),
});

/** Private manifest: explicit expected populations prevent absent-file success. */
export const shipmentEvidenceAuditInput = z.object({
  expectedBatchIds: z.array(z.string().min(1)).min(1),
  expectedEmailIds: z.array(emailIdentity.shape.id).min(1),
  originals: z.array(retainedMailPages),
  resolvedCarriers: z
    .array(z.object({ name: z.string().min(1), id: vendorShortcode }))
    .default([]),
  batches: z.array(batch),
});

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable));
  if (typeof value === "object" && value !== null)
    return JSON.stringify(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [key, stable(field)]),
    );
  return JSON.stringify(value) ?? "undefined";
};

type AuditBatch = z.infer<typeof batch>;
type AuditRecord = z.infer<typeof record>;
type Timeline = z.infer<typeof shipmentTimelineOut>;
type Observation = Timeline["observations"][number];

const immutableEvidence = (row: Observation) => ({
  kind: row.kind,
  time: row.time,
  timeBasis: row.timeBasis,
  rawStatus: row.rawStatus,
  location: row.location,
  carrierId: row.carrierId,
  carrierName: row.carrierName,
  trackingNumber: row.trackingNumber,
  source: row.source,
  sourceEventKey: row.sourceEventKey,
  sourcePackageId: row.sourcePackageId,
  sourceCaptureId: row.sourceCaptureId,
  memberReviewed: row.memberReviewed,
});

function validSuccessor(original: Observation, timeline: Timeline) {
  const visited = new Set<string>();
  let row = original;
  while (row.superseded && !visited.has(row.observationId)) {
    visited.add(row.observationId);
    const next = timeline.observations.find(
      (candidate) => candidate.observationId === row.supersededByObservationId,
    );
    if (
      !next ||
      next.sourcePackageId !== original.sourcePackageId ||
      next.sourceEventKey !== original.sourceEventKey
    )
      return false;
    row = next;
  }
  return row.observationId !== original.observationId && !row.superseded;
}

function auditRecord(
  packet: AuditRecord,
  item: AuditBatch,
  carriers: ReadonlyMap<string, string>,
) {
  const errors: string[] = [];
  const expectedCount = packet.shipments.reduce(
    (count, shipment) => count + shipment.observations.length,
    0,
  );
  if (
    packet.receipt.insertedObservations +
      packet.receipt.repeatedObservations !==
    expectedCount
  )
    errors.push(`${packet.source.id}: receipt observation count mismatch`);
  const wantedTargets = new Set(
    packet.shipments.map((shipment) => shipment.shipmentId),
  );
  if (wantedTargets.has(null))
    errors.push(
      `${packet.source.id}: resolve created Shipment IDs before auditing`,
    );
  if (
    stable([...wantedTargets].sort()) !==
    stable([...new Set(packet.receipt.shipmentIds)].sort())
  )
    errors.push(`${packet.source.id}: receipt target mismatch`);
  const used = new Map<string | null, Set<string>>();
  for (const shipment of packet.shipments) {
    const matched = used.get(shipment.shipmentId) ?? new Set<string>();
    used.set(shipment.shipmentId, matched);
    const timeline = item.timelines.find(
      (row) => row.shipmentId === shipment.shipmentId,
    );
    const before = item.beforeTimelines.find(
      (row) => row.shipmentId === shipment.shipmentId,
    );
    if (!before)
      errors.push(`${shipment.shipmentId}: missing prior-evidence baseline`);
    if (!timeline) {
      errors.push(`${shipment.shipmentId}: missing timeline readback`);
      continue;
    }
    for (const prior of before?.observations ?? []) {
      const after = timeline.observations.find(
        (row) => row.observationId === prior.observationId,
      );
      // Recording may refresh capture attribution and supersede an unreviewed version;
      // all prior literal evidence remains immutable and reviewed versions stay protected.
      if (
        !after ||
        stable(immutableEvidence(prior)) !== stable(immutableEvidence(after))
      )
        errors.push(
          `${shipment.shipmentId}: prior observation changed or disappeared`,
        );
      if (
        after &&
        prior.memberReviewed &&
        !prior.superseded &&
        after.superseded
      )
        errors.push(
          `${shipment.shipmentId}: reviewed observation was superseded by source replay`,
        );
    }
    for (const observation of shipment.observations) {
      if (!datedShipmentEventTime.safeParse(observation.time).success)
        errors.push(`${packet.source.id}: observation lacks a calendar date`);
      const carrierName = observation.carrierName;
      const namedCarrier = carrierName
        ? carriers.get(carrierName.trim().toLowerCase())
        : null;
      const carrierId = observation.carrierId ?? namedCarrier;
      if (namedCarrier === undefined)
        errors.push(`${packet.source.id}: missing verified carrier resolution`);
      if (namedCarrier && carrierId !== namedCarrier)
        errors.push(
          `${packet.source.id}: carrier reference and literal name disagree`,
        );
      const found = timeline.observations.find(
        (row) =>
          !matched.has(row.observationId) &&
          row.source.kind === "email" &&
          row.source.emailId === packet.source.id &&
          (row.source.checksum === packet.source.checksum ||
            row.captureSources?.some(
              (capture) =>
                row.captureIds.includes(capture.captureId) &&
                capture.source.kind === "email" &&
                capture.source.emailId === packet.source.id &&
                capture.source.checksum === packet.source.checksum,
            )) &&
          row.kind === observation.kind &&
          row.rawStatus === observation.rawStatus &&
          row.location === observation.location &&
          row.carrierId === carrierId &&
          row.carrierName === observation.carrierName &&
          row.trackingNumber === observation.trackingNumber &&
          stable(row.time) === stable(observation.time) &&
          row.sourceEventKey === observation.sourceEventKey &&
          (row.timeBasis === observation.timeBasis ||
            (row.timeBasis === undefined &&
              before?.observations.some(
                (prior) =>
                  prior.observationId === row.observationId &&
                  prior.timeBasis === undefined,
              ))),
      );
      if (!found)
        errors.push(`${packet.source.id}: observation missing from readback`);
      else {
        matched.add(found.observationId);
        if (found.superseded && !validSuccessor(found, timeline))
          errors.push(
            `${packet.source.id}: superseded replay lacks a verified successor`,
          );
      }
    }
  }
  return errors;
}

export function auditShipmentEvidence(
  input: z.infer<typeof shipmentEvidenceAuditInput>,
) {
  const errors: string[] = [];
  const expected = new Set(input.expectedEmailIds);
  const expectedBatches = new Set(input.expectedBatchIds);
  if (expected.size !== input.expectedEmailIds.length)
    errors.push("Expected Email population contains duplicates");
  if (expectedBatches.size !== input.expectedBatchIds.length)
    errors.push("Expected batch population contains duplicates");
  const originals = new Map(
    input.originals.map((source) => [source.emailId, source]),
  );
  if (originals.size !== input.originals.length)
    errors.push("Original population contains duplicates");
  for (const id of expected) {
    const source = originals.get(id);
    if (!source) errors.push(`${id}: missing original`);
    else
      errors.push(
        ...completeRetainedMail(source).errors.map(
          (error) => `${id}: ${error}`,
        ),
      );
  }
  for (const id of originals.keys())
    if (!expected.has(id))
      errors.push(`${id}: original outside expected scope`);
  const batches = new Set<string>();
  const dispositions = new Set<string>();
  const carriers = new Map(
    input.resolvedCarriers.map((carrier) => [
      carrier.name.trim().toLowerCase(),
      carrier.id,
    ]),
  );
  let observationsChecked = 0;
  for (const item of input.batches) {
    if (batches.has(item.id)) errors.push(`${item.id}: duplicate batch`);
    batches.add(item.id);
    if (!expectedBatches.has(item.id))
      errors.push(`${item.id}: unexpected batch`);
    const expectedRecords = new Set(item.expectedRecordIds);
    const actualRecords = new Set(item.records.map((row) => row.id));
    if (
      expectedRecords.size !== item.expectedRecordIds.length ||
      actualRecords.size !== item.records.length
    )
      errors.push(`${item.id}: duplicate record identity`);
    for (const id of expectedRecords)
      if (!actualRecords.has(id))
        errors.push(`${item.id}: missing planned record/receipt ${id}`);
    for (const id of actualRecords)
      if (!expectedRecords.has(id))
        errors.push(`${item.id}: unexpected record ${id}`);
    for (const disposition of item.dispositions) {
      const source = originals.get(disposition.emailId);
      if (
        !expected.has(disposition.emailId) ||
        source?.checksum !== disposition.checksum
      )
        errors.push(
          `${disposition.emailId}: disposition source/checksum mismatch`,
        );
      dispositions.add(disposition.emailId);
    }
    for (const packet of item.records) {
      const source = originals.get(packet.source.id);
      if (
        !expected.has(packet.source.id) ||
        source?.checksum !== packet.source.checksum
      )
        errors.push(`${packet.source.id}: record source/checksum mismatch`);
      errors.push(...auditRecord(packet, item, carriers));
      observationsChecked += packet.shipments.reduce(
        (count, shipment) => count + shipment.observations.length,
        0,
      );
    }
  }
  for (const id of expectedBatches)
    if (!batches.has(id))
      errors.push(`${id}: missing batch/verification input`);
  for (const id of expected)
    if (!dispositions.has(id))
      errors.push(`${id}: missing disposition or explicit review hold`);
  return {
    ok: errors.length === 0,
    sourcesChecked: expected.size,
    observationsChecked,
    errors,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [manifest, output] = process.argv.slice(2);
  if (!manifest || !output)
    throw new Error(
      "Usage: audit-shipment-evidence.ts <private-manifest.json> <private-report.json>",
    );
  const input = shipmentEvidenceAuditInput.parse(
    JSON.parse(await readFile(manifest, "utf8")),
  );
  const report = auditShipmentEvidence(input);
  await writeFile(output, JSON.stringify(report, null, 2));
  // Detailed findings contain source identities and stay in the requested private report.
  process.stdout.write(
    JSON.stringify({
      ok: report.ok,
      sourcesChecked: report.sourcesChecked,
      observationsChecked: report.observationsChecked,
      errors: report.errors.length,
    }) + "\n",
  );
  if (!report.ok) process.exitCode = 1;
}
