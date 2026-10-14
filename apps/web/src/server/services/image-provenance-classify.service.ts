import { createHash } from "node:crypto";

import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { imageSourceEvidence } from "@cubby/schemas/image-capture-fields";
import type {
  ClassifyImageProvenanceInput,
  ClassifyImageProvenanceOut,
} from "@cubby/schemas/maintenance";

import type { AiRunContext } from "~/server/ai/run-feature";
import { decideImageProvenanceWithEvidence } from "~/server/ai/semantic-decisions";
import type { Database } from "~/server/db";
import {
  countImagesForProvenanceClassification,
  loadAnalysisCapturedAtForImages,
  publishImageSourceClassifications,
  selectImagesForProvenanceClassification,
  type ImageProvenanceCandidateRow,
  type ImageSourceClassificationPublication,
} from "~/server/repo/image";
import { aiCallRunInput, ensureRun } from "~/server/runs/ensure-run";

type ImageDecision = Awaited<
  ReturnType<typeof decideImageProvenanceWithEvidence>
>;

export interface ImageProvenanceClassifierPorts {
  select: typeof selectImagesForProvenanceClassification;
  count: typeof countImagesForProvenanceClassification;
  loadAnalysisCapturedAt: typeof loadAnalysisCapturedAtForImages;
  publish: typeof publishImageSourceClassifications;
  decide: (
    row: ImageProvenanceCandidateRow,
    usage: AiRunContext,
  ) => Promise<ImageDecision>;
  ensureRun: (db: Database, actorContext: ActorContext) => Promise<RunId>;
}

const productionPorts: ImageProvenanceClassifierPorts = {
  select: selectImagesForProvenanceClassification,
  count: countImagesForProvenanceClassification,
  loadAnalysisCapturedAt: loadAnalysisCapturedAtForImages,
  publish: publishImageSourceClassifications,
  decide: (row, usage) =>
    decideImageProvenanceWithEvidence({
      input: {
        filename: row.filename,
        width: row.width,
        height: row.height,
        sourceAssetUrl: row.sourceAssetUrl,
        sourcePageUrl: row.sourcePageUrl,
        sourceName: row.sourceName,
        sightingSourceTypes: [],
        hasExifCamera: Boolean(row.embeddedMetadata?.camera),
        hasExifCaptureTime: Boolean(row.embeddedMetadata?.capturedAt),
        analysisSummary: null,
      },
      usage,
    }),
  ensureRun: (db, actorContext) =>
    ensureRun(db, actorContext, aiCallRunInput(actorContext)),
};

const MAX_CLASSIFICATION_CANDIDATES = 100;

const evidenceFingerprint = (row: ImageProvenanceCandidateRow): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        filename: row.filename,
        width: row.width,
        height: row.height,
        sourceAssetUrl: row.sourceAssetUrl,
        sourcePageUrl: row.sourcePageUrl,
        sourceName: row.sourceName,
      }),
    )
    .digest("hex");

const isConcrete = (
  value: ImageDecision["value"],
): value is "own" | "catalog" | "screenshot" =>
  value === "own" || value === "catalog" || value === "screenshot";

/**
 * Freeze one bounded candidate roster, prepare every Decision before writes,
 * then publish all concrete outcomes in one transaction. An error from any
 * model call therefore leaves this invocation's image rows untouched.
 */
export async function classifyImageProvenance(
  db: Database,
  input: ClassifyImageProvenanceInput,
  actorContext: ActorContext,
  ports: ImageProvenanceClassifierPorts = productionPorts,
): Promise<ClassifyImageProvenanceOut> {
  const limit = Math.min(
    input.batchSize * input.maxBatches,
    MAX_CLASSIFICATION_CANDIDATES,
  );
  const selected = await ports.select(db, limit + 1, input.afterId);
  const hasMore = selected.length > limit;
  const rows = selected.slice(0, limit);
  const remainingBefore = await ports.count(db);
  if (rows.length === 0) {
    return {
      dryRun: input.dryRun,
      batches: 0,
      scanned: 0,
      classified: 0,
      capturedAtSeeded: 0,
      unresolved: 0,
      remaining: remainingBefore,
      nextCursor: null,
      stopped: "complete",
    };
  }

  const runId = await ports.ensureRun(db, actorContext);
  const usage: AiRunContext = {
    db,
    runId,
    operation: "maintenance.image-provenance-classification",
  };
  const analysisCapturedAt = await ports.loadAnalysisCapturedAt(
    db,
    rows.map((row) => row.id),
  );
  const prepared: ImageSourceClassificationPublication[] = [];
  let unresolved = 0;
  let preparedClassifications = 0;
  let preparedCaptureDates = 0;
  for (const row of rows) {
    const analysisTime =
      row.capturedAt === null ? analysisCapturedAt.get(row.id) : undefined;
    const updates: ImageSourceClassificationPublication = {
      id: row.id,
      expectedUpdatedAt: row.updatedAtToken,
      ...(analysisTime !== undefined
        ? { analysisCapturedAt: analysisTime }
        : {}),
    };
    const decision = await ports.decide(row, usage);
    if (isConcrete(decision.value) && decision.confidence === "high") {
      updates.source = decision.value;
      updates.sourceEvidence = imageSourceEvidence.parse({
        basis: "decision",
        feature: decision.feature,
        promptVersion: decision.promptVersion,
        model: decision.model,
        runId,
        confidence: "high",
        probability: decision.probability,
        evidenceFingerprint: evidenceFingerprint(row),
        value: decision.value,
      });
      preparedClassifications += 1;
    } else {
      unresolved += 1;
    }
    if (updates.source || updates.analysisCapturedAt) {
      if (updates.analysisCapturedAt) preparedCaptureDates += 1;
      prepared.push(updates);
    }
  }

  const publication = input.dryRun
    ? {
        classified: preparedClassifications,
        capturedAtSeeded: preparedCaptureDates,
      }
    : prepared.length === 0
      ? { classified: 0, capturedAtSeeded: 0 }
      : await ports.publish(db, prepared);
  const remaining = await ports.count(db);
  return {
    dryRun: input.dryRun,
    batches: Math.ceil(rows.length / input.batchSize),
    scanned: rows.length,
    classified: publication.classified,
    capturedAtSeeded: publication.capturedAtSeeded,
    unresolved:
      unresolved +
      (input.dryRun ? 0 : preparedClassifications - publication.classified),
    remaining,
    nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    stopped: hasMore ? "limit" : "complete",
  };
}
