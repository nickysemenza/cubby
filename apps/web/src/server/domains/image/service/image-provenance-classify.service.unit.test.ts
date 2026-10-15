import { runEntityId } from "@cubby/schemas/identifiers";
import { testShortcode, testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import type { ImageProvenanceCandidateRow } from "~/server/domains/image/repo/image";
import { systemActor } from "~/server/domains/run/repo/ensure-run";

import {
  classifyImageProvenance,
  type ImageProvenanceClassifierPorts,
} from "./image-provenance-classify.service";

const db = {} as Database;
const runId = runEntityId.parse("11111111-1111-4111-8111-111111111111");
const candidate = (id: string): ImageProvenanceCandidateRow => ({
  id: testEntityId("image", id),
  filename: "image.jpg",
  sourceAssetUrl: null,
  sourcePageUrl: null,
  sourceName: null,
  embeddedMetadata: null,
  width: 1200,
  height: 800,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  updatedAtToken: "2026-01-01 00:00:00.000000+00",
  capturedAt: null,
  provenanceEvidence: null,
  sightingSourceTypes: [],
});

const decision = (
  value: "own" | "catalog" | "screenshot" | "unknown",
  confidence: "high" | "medium" | "low" = "high",
) => ({
  value,
  confidence,
  probability: confidence === "high" ? 0.94 : 0.67,
  model: "typesafe/jev" as const,
  feature: "image-provenance-classification" as const,
  promptVersion: "2026-10-14.1",
});

const portsFor = (
  rows: ImageProvenanceCandidateRow[],
  decide: ImageProvenanceClassifierPorts["decide"],
  publish: ImageProvenanceClassifierPorts["publish"] = vi.fn<
    ImageProvenanceClassifierPorts["publish"]
  >(async (_database, changes) => ({
    classified: changes.filter((change) => change.source).length,
    capturedAtSeeded: changes.filter((change) => change.analysisCapturedAt)
      .length,
  })),
): ImageProvenanceClassifierPorts => ({
  select: vi.fn(async () => rows),
  count: vi.fn(async () => rows.length),
  loadAnalysisCapturedAt: vi.fn(async () => new Map()),
  publish,
  decide,
  ensureRun: vi.fn(async () => runId),
  resolveRun: vi.fn(async () => testShortcode("run", "4K7M")),
});

describe("classifyImageProvenance", () => {
  it("does not publish any prepared row when a later model decision fails", async () => {
    const rows = [
      candidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      candidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ];
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("Test candidates are missing.");
    const publish = vi.fn();
    const ports = portsFor(
      rows,
      vi.fn(async (_row, _usage) => {
        if (_row.id === second.id) throw new Error("decision gateway failed");
        return decision("catalog");
      }),
      publish,
    );

    await expect(
      classifyImageProvenance(
        db,
        { dryRun: false, batchSize: 2, maxBatches: 1 },
        systemActor(),
        ports,
      ),
    ).rejects.toThrow("decision gateway failed");
    expect(ports.select).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps unknown visible, continues through the frozen roster, and preserves analysis date copying", async () => {
    const rows = [
      candidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      candidate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ];
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("Test candidates are missing.");
    const capturedAt = new Date("2024-03-01T12:00:00Z");
    const publish = vi.fn<ImageProvenanceClassifierPorts["publish"]>(
      async (_database, changes) => ({
        classified: changes.filter((change) => change.source).length,
        capturedAtSeeded: changes.filter((change) => change.analysisCapturedAt)
          .length,
      }),
    );
    const ports = portsFor(
      rows,
      vi.fn(async (_row, _usage) =>
        _row.id === first.id ? decision("unknown") : decision("own"),
      ),
      publish,
    );
    ports.loadAnalysisCapturedAt = vi.fn(
      async () => new Map([[first.id, capturedAt]]),
    );

    const result = await classifyImageProvenance(
      db,
      { dryRun: false, batchSize: 2, maxBatches: 1 },
      systemActor(),
      ports,
    );

    expect(result).toMatchObject({
      scanned: 2,
      classified: 1,
      capturedAtSeeded: 1,
      unresolved: 1,
    });
    expect(ports.select).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          analysisCapturedAt: capturedAt,
        }),
        expect.objectContaining({
          id: second.id,
          source: "own",
          sourceEvidence: expect.objectContaining({ basis: "decision" }),
        }),
      ]),
    );
  });

  it("does not publish a medium-confidence source choice", async () => {
    const rows = [candidate("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")];
    const publish = vi.fn<ImageProvenanceClassifierPorts["publish"]>();
    const ports = portsFor(
      rows,
      vi.fn(async () => decision("own", "medium")),
      publish,
    );

    const result = await classifyImageProvenance(
      db,
      { dryRun: false, batchSize: 1, maxBatches: 1 },
      systemActor(),
      ports,
    );

    expect(result).toMatchObject({ classified: 0, unresolved: 1 });
    expect(publish).not.toHaveBeenCalled();
  });
});
