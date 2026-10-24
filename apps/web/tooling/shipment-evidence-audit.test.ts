import { describe, expect, it } from "vitest";
import { vendorShortcode } from "@cubby/schemas/identifiers";

import {
  completeRetainedMail,
  retainedMailPage,
  retainedMailPages,
} from "./retained-mail-pages";
import {
  auditShipmentEvidence,
  shipmentEvidenceAuditInput,
} from "./shipment-evidence-audit";

const emailId = "EML-2ABC4";
const checksum = "a".repeat(64);
const page = ({
  offset = 0,
  body = "Parcel update",
  nextOffset = null,
  mode = "text",
  total = new TextEncoder().encode(body).length,
  truncated = false,
}: {
  offset?: number;
  body?: string;
  nextOffset?: number | null;
  mode?: "text" | "html";
  total?: number;
  truncated?: boolean;
} = {}) => ({
  offset,
  response: {
    id: emailId,
    mailboxId: "synthetic-mailbox",
    messageId: "synthetic-message",
    checksum,
    content: {
      snippet: null,
      bodyText: mode === "text" ? body : null,
      bodyHtml: mode === "html" ? body : null,
      textBytes: mode === "text" ? total : null,
      htmlBytes: mode === "html" ? total : null,
      nextOffset,
      compacted: false,
      truncated,
    },
  },
});
const source = () =>
  retainedMailPages.parse({
    emailId,
    checksum,
    textPages: [page()],
    htmlPages: [],
  });

describe("retained shipment evidence audit", () => {
  it("accepts continued compact pages once every byte is read", () => {
    const input = retainedMailPages.parse({
      emailId,
      checksum,
      htmlPages: [],
      textPages: [
        page({ body: "📦", nextOffset: 4, total: 6, truncated: true }),
        page({ offset: 4, body: "ok", total: 6 }),
      ],
    });
    expect(completeRetainedMail(input)).toMatchObject({
      complete: true,
      mode: "text",
      text: "📦ok",
    });
    for (const item of input.textPages) if (item.offset === 4) item.offset = 3;
    expect(completeRetainedMail(input).complete).toBe(false);
  });

  it("recovers incomplete compact evidence through a complete HTML sequence", () => {
    const input = retainedMailPages.parse({
      emailId,
      checksum,
      textPages: [page({ truncated: true })],
      htmlPages: [
        page({
          mode: "html",
          body: "<p>",
          total: 9,
          nextOffset: 3,
          truncated: true,
        }),
        page({
          mode: "html",
          offset: 3,
          body: "ok</p>",
          total: 9,
          truncated: true,
        }),
      ],
    });
    expect(completeRetainedMail(input)).toMatchObject({
      complete: true,
      mode: "html",
      text: "<p>ok</p>",
    });
    for (const item of input.textPages) {
      item.response.content.truncated = false;
      item.response.content.linksOmitted = 1;
    }
    expect(completeRetainedMail(input).mode).toBe("html");
    input.htmlPages.pop();
    expect(completeRetainedMail(input).complete).toBe(false);
  });

  it("refuses changed original identity even when another representation is complete", () => {
    const input = source();
    input.htmlPages.push(retainedMailPage.parse(page({ mode: "html" })));
    for (const item of input.textPages) item.response.checksum = "b".repeat(64);
    expect(completeRetainedMail(input).complete).toBe(false);
  });

  it("requires every expected batch and source disposition instead of skipping absent inputs", () => {
    const input = shipmentEvidenceAuditInput.parse({
      expectedBatchIds: ["batch-a"],
      expectedEmailIds: [emailId],
      originals: [source()],
      batches: [],
    });
    const report = auditShipmentEvidence(input);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        "batch-a: missing batch/verification input",
        `${emailId}: missing disposition or explicit review hold`,
      ]),
    );
    input.batches.push({
      id: "batch-a",
      expectedRecordIds: [],
      records: [],
      timelines: [],
      beforeTimelines: [],
      dispositions: [
        {
          emailId: source().emailId,
          checksum,
          outcome: "unresolved",
          reason: "No package event in original",
        },
      ],
    });
    expect(auditShipmentEvidence(input)).toMatchObject({
      ok: true,
      sourcesChecked: 1,
    });
    const firstBatch = input.batches.at(0);
    if (!firstBatch) throw new Error("Missing synthetic batch");
    const disposition = firstBatch.dispositions[0];
    if (!disposition) throw new Error("Missing synthetic disposition");
    disposition.outcome = "linked";
    expect(auditShipmentEvidence(input).errors).toContain(
      `${emailId}: linked disposition lacks a verified resolution receipt`,
    );
    disposition.outcome = "unresolved";
    firstBatch.expectedRecordIds.push("planned-evidence");
    expect(auditShipmentEvidence(input).errors).toContain(
      "batch-a: missing planned record/receipt planned-evidence",
    );
  });

  it("checks each observation from the same Email and preserves the prior evidence", () => {
    const event = {
      sourceEventKey: "scan-a",
      kind: "delivered",
      timeBasis: "stated_event",
      time: { kind: "date", value: "2026-06-06" },
      rawStatus: "Delivered",
      location: null,
      carrierId: null,
      carrierName: null,
      trackingNumber: "EXAMPLE-123",
    };
    const retained = {
      ...event,
      observationId: "10000000-0000-4000-8000-000000000001",
      sourceCaptureId: "10000000-0000-4000-8000-000000000002",
      sourcePackageId: "10000000-0000-4000-8000-000000000003",
      captureIds: [],
      source: { kind: "email", emailId, checksum },
      firstSeenAt: "2026-06-06T12:00:00Z",
      lastSeenAt: "2026-06-06T12:00:00Z",
      superseded: false,
      memberReviewed: false,
    };
    const timeline = {
      shipmentId: "SHIP-2ABC4",
      observations: [retained],
      timeline: [],
      milestones: {
        carrierPossessionAt: null,
        deliveredAt: null,
        fulfillmentHours: null,
        transitHours: null,
        totalWaitHours: null,
        conflicts: [],
      },
    };
    const second = {
      ...event,
      sourceEventKey: "scan-b",
      rawStatus: "Left at front door",
    };
    const input = shipmentEvidenceAuditInput.parse({
      expectedBatchIds: ["batch-a"],
      expectedEmailIds: [emailId],
      originals: [source()],
      batches: [
        {
          id: "batch-a",
          expectedRecordIds: ["source-a"],
          records: [
            {
              id: "source-a",
              source: { id: emailId, checksum },
              shipments: [
                {
                  shipmentId: "SHIP-2ABC4",
                  sourceShipmentKey: null,
                  distinctPackageEvidence: null,
                  carrierId: null,
                  carrierName: null,
                  trackingNumber: "EXAMPLE-123",
                  extraTrackingNumbers: [],
                  purpose: "incoming",
                  observations: [event, second],
                },
              ],
              receipt: {
                shipmentIds: ["SHIP-2ABC4"],
                insertedObservations: 1,
                repeatedObservations: 1,
              },
            },
          ],
          dispositions: [
            {
              emailId,
              checksum,
              outcome: "unresolved",
              reason: "Purchase identity unknown",
            },
          ],
          beforeTimelines: [timeline],
          timelines: [timeline],
        },
      ],
    });
    expect(auditShipmentEvidence(input).errors).toContain(
      `${emailId}: observation missing from readback`,
    );
    const batch = input.batches.at(0);
    const after = batch?.timelines.at(0);
    const first = after?.observations.at(0);
    if (!batch || !after || !first)
      throw new Error("Missing synthetic timeline");
    after.observations.push({
      ...first,
      ...second,
      kind: first.kind,
      timeBasis: first.timeBasis,
      time: first.time,
      observationId: "10000000-0000-4000-8000-000000000004",
    });
    expect(auditShipmentEvidence(input).ok).toBe(true);
    first.rawStatus = "Rewritten prior evidence";
    expect(auditShipmentEvidence(input).errors).toContain(
      "SHIP-2ABC4: prior observation changed or disappeared",
    );
    first.rawStatus = "Delivered";
    first.trackingNumber = "WRONG-TRACKING";
    expect(auditShipmentEvidence(input).errors).toContain(
      "SHIP-2ABC4: prior observation changed or disappeared",
    );
    first.trackingNumber = "EXAMPLE-123";

    const record = batch.records.at(0);
    const packet = record?.shipments.at(0);
    const wanted = packet?.observations.at(0);
    const before = batch.beforeTimelines.at(0);
    if (!record || !packet || !wanted || !before)
      throw new Error("Missing synthetic packet");
    // Coarse repeated occurrences must consume separate saved rows.
    before.observations = [];
    wanted.sourceEventKey = null;
    packet.observations = [wanted, { ...wanted }];
    first.sourceEventKey = null;
    after.observations = [first];
    expect(auditShipmentEvidence(input).errors).toContain(
      `${emailId}: observation missing from readback`,
    );
    after.observations.push({
      ...first,
      observationId: "10000000-0000-4000-8000-000000000004",
    });
    expect(auditShipmentEvidence(input).ok).toBe(true);

    // Replaying tagged input preserves historical missing provenance and a
    // member's reviewed successor instead of requiring the input to overwrite it.
    packet.observations = [wanted];
    record.receipt.insertedObservations = 0;
    record.receipt.repeatedObservations = 1;
    delete first.timeBasis;
    before.observations = [{ ...first }];
    first.superseded = true;
    first.supersededByObservationId = "10000000-0000-4000-8000-000000000004";
    after.observations = [
      first,
      {
        ...first,
        observationId: "10000000-0000-4000-8000-000000000004",
        time: { kind: "date", value: "2026-06-07" },
        superseded: false,
        supersededByObservationId: null,
        memberReviewed: true,
      },
    ];
    expect(auditShipmentEvidence(input).ok).toBe(true);
    const successor = after.observations.at(1);
    if (!successor) throw new Error("Missing synthetic successor");
    successor.memberReviewed = false;
    expect(auditShipmentEvidence(input).ok).toBe(true);

    // Two versions in one revision chain cannot prove two source occurrences.
    successor.time = first.time;
    packet.observations = [wanted, { ...wanted }];
    record.receipt.repeatedObservations = 2;
    expect(auditShipmentEvidence(input).errors).toContain(
      `${emailId}: observation missing from readback`,
    );
    packet.observations = [wanted];
    record.receipt.repeatedObservations = 1;
    // Package carrier metadata does not supply observation carrier claims.
    packet.carrierId = vendorShortcode.parse("VEN-2ABC4");
    packet.carrierName = "Synthetic carrier";
    expect(auditShipmentEvidence(input).ok).toBe(true);

    // A refreshed capture can retain the original observation attribution.
    first.source = {
      kind: "email",
      emailId: input.expectedEmailIds[0]!,
      checksum: "b".repeat(64),
    };
    before.observations = [{ ...first, superseded: false }];
    first.captureIds = ["10000000-0000-4000-8000-000000000005"];
    first.captureSources = [
      {
        captureId: "10000000-0000-4000-8000-000000000005",
        source: {
          kind: "email",
          emailId: input.expectedEmailIds[0]!,
          checksum,
        },
      },
    ];
    expect(auditShipmentEvidence(input).ok).toBe(true);
    first.captureIds = [];
    expect(auditShipmentEvidence(input).errors).toContain(
      `${emailId}: observation missing from readback`,
    );
  });
});
