import type {
  ClassifyImageProvenanceInput,
  ClassifyImageProvenanceOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesForProvenanceClassification,
  getImageCaptureState,
  loadAnalysisCapturedAtForImages,
  selectImagesForProvenanceClassification,
  setImageCaptureState,
  type ImageProvenanceCandidateRow,
} from "~/server/repo/image";
import type { DeriveImageCaptureCurrent } from "~/server/services/image-capture-derivation";
import {
  classifyImageProvenanceFromFilename,
  filenameProvenanceRuleIds,
  seedCapturedAtFromAnalysis,
  type FilenameProvenanceResult,
} from "~/server/services/image-provenance-heuristics";

type ClassifyPorts = {
  select: typeof selectImagesForProvenanceClassification;
  count: typeof countImagesForProvenanceClassification;
  loadAnalysisCapturedAt: typeof loadAnalysisCapturedAtForImages;
  getCaptureState: typeof getImageCaptureState;
  setCaptureState: typeof setImageCaptureState;
};

const productionPorts: ClassifyPorts = {
  select: selectImagesForProvenanceClassification,
  count: countImagesForProvenanceClassification,
  loadAnalysisCapturedAt: loadAnalysisCapturedAtForImages,
  getCaptureState: getImageCaptureState,
  setCaptureState: setImageCaptureState,
};

const emptyRuleCounts = (): Record<string, number> =>
  Object.fromEntries(filenameProvenanceRuleIds.map((ruleId) => [ruleId, 0]));

type SeedResult = ReturnType<typeof seedCapturedAtFromAnalysis>;

interface RowClassification {
  filenameResult: FilenameProvenanceResult | null;
  analysisResult: SeedResult;
}

/** Runs both heuristics against one candidate row's current capture state. */
const classifyCandidateRow = (
  row: ImageProvenanceCandidateRow,
  current: DeriveImageCaptureCurrent,
  analysisCapturedAt: Date | null,
): RowClassification => ({
  filenameResult: classifyImageProvenanceFromFilename(row),
  analysisResult: seedCapturedAtFromAnalysis(
    current.capturedAt,
    analysisCapturedAt,
  ),
});

interface TallyResult {
  classified: boolean;
  capturedAtSeeded: boolean;
}

/** Tallies one row's classification into the running counters; mutates `byRule`. */
const tallyClassification = (
  byRule: Record<string, number>,
  { filenameResult, analysisResult }: RowClassification,
): TallyResult => {
  if (filenameResult) {
    byRule[filenameResult.provenanceEvidence.ruleId] =
      (byRule[filenameResult.provenanceEvidence.ruleId] ?? 0) + 1;
  }
  return {
    classified: filenameResult !== null,
    capturedAtSeeded: analysisResult !== null,
  };
};

/**
 * The capture state to write for a row with at least one heuristic match.
 * Analysis outranks filename in `image-capture-derivation.ts`'s precedence
 * (`manual > sighting > import-url > exif > analysis > filename`); when both
 * fire in the same pass the written basis is "analysis" even though `source`
 * still comes from the filename rule.
 */
const mergedCaptureState = (
  current: DeriveImageCaptureCurrent,
  { filenameResult, analysisResult }: RowClassification,
): DeriveImageCaptureCurrent => ({
  ...current,
  source: filenameResult?.source ?? current.source,
  capturedAt: analysisResult?.capturedAt ?? current.capturedAt,
  provenanceEvidence:
    analysisResult?.provenanceEvidence ??
    filenameResult?.provenanceEvidence ??
    current.provenanceEvidence,
});

/**
 * `dryRun` classifies exactly one page (`batchSize` rows) and writes
 * nothing. Looping across pages the way `applyClassification` does would be
 * meaningless here — a dry run never shrinks the candidate set, so a second
 * page read would return the identical rows. `stopped: "limit"` means the
 * candidate set is larger than the one previewed page; increase `batchSize`
 * (or apply for real) to see further.
 */
async function previewClassification(
  db: Database,
  input: ClassifyImageProvenanceInput,
  ports: ClassifyPorts,
): Promise<ClassifyImageProvenanceOut> {
  const rows = await ports.select(db, input.batchSize);
  const analysisCapturedAt = await ports.loadAnalysisCapturedAt(
    db,
    rows.map((row) => row.id),
  );
  const byRule = emptyRuleCounts();
  let classified = 0;
  let capturedAtSeeded = 0;
  for (const row of rows) {
    const current = await ports.getCaptureState(db, row.id);
    if (!current) continue;
    const result = tallyClassification(
      byRule,
      classifyCandidateRow(
        row,
        current,
        analysisCapturedAt.get(row.id) ?? null,
      ),
    );
    if (result.classified) classified += 1;
    if (result.capturedAtSeeded) capturedAtSeeded += 1;
  }
  const remaining = await ports.count(db);
  return {
    dryRun: true,
    batches: rows.length > 0 ? 1 : 0,
    scanned: rows.length,
    classified,
    capturedAtSeeded,
    byRule,
    remaining,
    stopped: rows.length < input.batchSize ? "complete" : "limit",
  };
}

interface ApplyBatchResult {
  classified: number;
  capturedAtSeeded: number;
  progressed: boolean;
}

/** One batch: classifies and writes every row with a heuristic match. Returns whether any row changed. */
async function applyBatch(
  db: Database,
  ports: ClassifyPorts,
  rows: readonly ImageProvenanceCandidateRow[],
  byRule: Record<string, number>,
): Promise<ApplyBatchResult> {
  const analysisCapturedAt = await ports.loadAnalysisCapturedAt(
    db,
    rows.map((row) => row.id),
  );
  let classified = 0;
  let capturedAtSeeded = 0;
  let progressed = false;
  for (const row of rows) {
    const current = await ports.getCaptureState(db, row.id);
    if (!current) continue; // deleted mid-run

    const classification = classifyCandidateRow(
      row,
      current,
      analysisCapturedAt.get(row.id) ?? null,
    );
    if (!classification.filenameResult && !classification.analysisResult)
      continue;
    progressed = true;

    const result = tallyClassification(byRule, classification);
    if (result.classified) classified += 1;
    if (result.capturedAtSeeded) capturedAtSeeded += 1;

    await ports.setCaptureState(
      db,
      row.id,
      mergedCaptureState(current, classification),
    );
  }
  return { classified, capturedAtSeeded, progressed };
}

/**
 * The bounded-loop write path, mirroring `repairImageDimensions`: each pass
 * selects a batch of candidate rows, classifies and writes them, and stops
 * on an empty page (`complete`), the batch limit (`limit`), or a repeated
 * page / a page with no matches (`no_progress`).
 */
async function applyClassification(
  db: Database,
  input: ClassifyImageProvenanceInput,
  ports: ClassifyPorts,
): Promise<ClassifyImageProvenanceOut> {
  let batches = 0;
  let scanned = 0;
  let classified = 0;
  let capturedAtSeeded = 0;
  let stopped: ClassifyImageProvenanceOut["stopped"] = "limit";
  const byRule = emptyRuleCounts();
  const seenPages = new Set<string>();

  while (batches < input.maxBatches) {
    const rows = await ports.select(db, input.batchSize);
    if (rows.length === 0) {
      stopped = "complete";
      break;
    }
    const pageKey = rows
      .map((row) => row.id)
      .sort()
      .join(",");
    if (seenPages.has(pageKey)) {
      stopped = "no_progress";
      break;
    }
    seenPages.add(pageKey);
    batches += 1;
    scanned += rows.length;

    const batch = await applyBatch(db, ports, rows, byRule);
    classified += batch.classified;
    capturedAtSeeded += batch.capturedAtSeeded;
    if (!batch.progressed) {
      stopped = "no_progress";
      break;
    }
  }

  const remaining = await ports.count(db);
  if (remaining === 0) stopped = "complete";
  return {
    dryRun: false,
    batches,
    scanned,
    classified,
    capturedAtSeeded,
    byRule,
    remaining,
    stopped,
  };
}

/**
 * Filename/dimension heuristics + on-device analysis `capturedAt` seeding for
 * images still `source = unknown` or last classified by a filename rule
 * (`image-provenance-heuristics.ts`). Writes back through the same
 * `getImageCaptureState`/`setImageCaptureState` repo functions
 * `image-capture-derivation.ts` uses — this never re-derives or duplicates
 * that module's precedence rule, it only ever touches the two lowest tiers
 * (`analysis`, `filename`), and the candidate SELECT itself is what keeps it
 * from ever touching a `manual`/`sighting`/`import-url`/`exif` row.
 */
export async function classifyImageProvenance(
  db: Database,
  input: ClassifyImageProvenanceInput,
  ports: ClassifyPorts = productionPorts,
): Promise<ClassifyImageProvenanceOut> {
  return input.dryRun
    ? previewClassification(db, input, ports)
    : applyClassification(db, input, ports);
}
