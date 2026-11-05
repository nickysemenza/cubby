import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor, type RunId } from "@cubby/schemas/identifiers";
import type {
  MaintenanceRunOut,
  MaintenanceRunSummary,
  MaintenanceStatus,
} from "@cubby/schemas/maintenance";
import { runStatus, runTrigger } from "@cubby/schemas/run-fields";

import type { Database } from "~/server/db";
import { imageProcessingMaintenanceSummary } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import {
  countCullablePendingImages,
  countImageMetadataOutcomes,
  countImagesStaleMetadata,
} from "~/server/domains/image/repo/image";
import {
  ACTIVE_MAINTENANCE_STATUSES,
  admitMaintenancePass,
  latestMaintenanceRun,
  readRunShortcode,
} from "~/server/domains/maintenance/repo/maintenance-run";
import { countStaleRecipeTotals } from "~/server/domains/recipe/repo/totals";
import {
  leftOf,
  listRunSteps,
  type RunStepRow,
  type StepRunOwner,
} from "~/server/domains/run/repo/run-step";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import { countUnembeddedSearchDocuments } from "~/server/generic/search/repo/search-document";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

const ACTIVE_CONSTRAINT = "Run_one_active_maintenance";
const PENDING_UPLOAD_HOURS = 24;

const launchedPass = async (
  db: Database,
  row: { id: RunId },
): Promise<MaintenanceRunOut> => {
  const shortcode = await readRunShortcode(db, row.id);
  if (!shortcode)
    throw new Error(`Maintenance Run ${row.id} vanished on launch`);
  return { runId: parseShortcodeFor("run", shortcode), existing: true };
};

/**
 * Starts one maintenance pass, or returns the one already running or paused. Racing
 * launches lose the `Run_one_active_maintenance` insert and return the winner instead.
 *
 * A nightly launch names its household date, and that date admits one pass: a repeated
 * invocation reuses it even after it finished, and it is never superseded by its own
 * date. Only an earlier night's budget-paused pass makes way.
 */
export async function launchMaintenanceRun(
  db: Database,
  actor: ActorContext,
  admission: "manual" | { householdDate: string },
): Promise<MaintenanceRunOut> {
  let admitted;
  try {
    admitted = await admitMaintenancePass(db, actor, admission);
  } catch (error) {
    if (!isUniqueViolation(error, ACTIVE_CONSTRAINT)) throw error;
    admitted = { active: true as const };
  }
  if ("active" in admitted) {
    const winner = await latestMaintenanceRun(db, true);
    if (!winner)
      throw new Error("The active maintenance pass finished during launch");
    return {
      runId: parseShortcodeFor("run", winner.shortcode),
      existing: true,
    };
  }
  if (admitted.status === null) {
    await launchWorkflowRun(db, { runId: admitted.id, purpose: "maintenance" });
    const out = await launchedPass(db, admitted);
    return { ...out, existing: false };
  }
  // The first invocation can die between committing the pass and launching it.
  if (admitted.status === runStatus.enum.running)
    await launchWorkflowRun(db, {
      runId: admitted.id,
      purpose: "maintenance",
      automatic: true,
    });
  return launchedPass(db, admitted);
}

const summarize = (
  row: StepRunOwner,
  steps: readonly RunStepRow[],
): MaintenanceRunSummary => {
  const index = steps.findIndex(
    (step) => step.state !== "done" && step.state !== "failed",
  );
  const current = index >= 0 ? steps[index] : undefined;
  return {
    runId: parseShortcodeFor("run", row.shortcode),
    status: runStatus.parse(row.status),
    trigger: runTrigger.parse(row.trigger),
    startedAt: (row.startedAt ?? row.createdAt).toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    failure: row.dispatchError ?? null,
    steps: steps.length,
    failedSteps: steps.filter((step) => step.state === "failed").length,
    current: current
      ? {
          position: index + 1,
          label: current.label,
          state: current.state,
          found: current.found,
          done: current.done,
          failed: current.failed,
          skipped: current.skipped,
          left: leftOf(current),
          pausedReason: current.pausedReason,
          pausedUntil: current.pausedUntil?.toISOString() ?? null,
        }
      : null,
  };
};

/** The active or most recent pass, and every backlog it drains. */
export async function readMaintenanceStatus(
  db: Database,
): Promise<MaintenanceStatus> {
  const latest = await latestMaintenanceRun(db, false);
  const latestActive =
    latest &&
    ACTIVE_MAINTENANCE_STATUSES.some((status) => status === latest.status);
  const [
    steps,
    staleImageMetadata,
    outcomes,
    staleRecipeTotals,
    unembeddedEntities,
    pendingUploads,
    imageProcessing,
  ] = await Promise.all([
    latest ? listRunSteps(db, latest.id) : Promise.resolve([]),
    countImagesStaleMetadata(db),
    countImageMetadataOutcomes(db),
    countStaleRecipeTotals(db),
    countUnembeddedEntities(db),
    countCullablePendingImages(db, PENDING_UPLOAD_HOURS),
    imageProcessingMaintenanceSummary(db),
  ]);
  const summary = latest ? summarize(latest, steps) : null;
  return {
    active: latestActive ? summary : null,
    last: latestActive ? null : summary,
    backlog: {
      staleImageMetadata,
      originalsMissing: outcomes.original_missing,
      metadataExtractionFailed: outcomes.extraction_failed,
      staleRecipeTotals,
      unembeddedEntities,
      pendingUploads,
      imageProcessing,
    },
    computedAt: new Date().toISOString(),
  };
}

/**
 * Without a gateway and vector store every live row reads as unembedded and
 * nothing can clear it, so the backlog is zero rather than an unfixable wall.
 */
export const countUnembeddedEntities = async (db: Database) =>
  semanticEmbeddingsConfigured()
    ? countUnembeddedSearchDocuments(db, getSemanticEmbeddingConfig())
    : 0;
