import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
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
  endBudgetPausedPass,
  latestMaintenanceRun,
  readRunShortcode,
} from "~/server/domains/maintenance/repo/maintenance-run";
import { countStaleRecipeTotals } from "~/server/domains/recipe/repo/totals";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
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

/**
 * Starts one maintenance pass, or returns the one already running or paused.
 * Racing launches lose the `Run_one_active_maintenance` insert and return the
 * winner instead.
 */
export async function launchMaintenanceRun(
  db: Database,
  actor: ActorContext,
  trigger: "manual" | "scheduled",
): Promise<MaintenanceRunOut> {
  let active = await latestMaintenanceRun(db, true);
  if (
    active &&
    trigger === "scheduled" &&
    (await endBudgetPausedPass(db, active.id))
  )
    active = await latestMaintenanceRun(db, true);
  if (active)
    return {
      runId: parseShortcodeFor("run", active.shortcode),
      existing: true,
    };
  let runId;
  try {
    runId = await ensureRun(db, actor, {
      purpose: "maintenance",
      trigger,
      status: "running",
      notes:
        trigger === "scheduled" ? "Nightly maintenance" : "Maintenance run now",
    });
  } catch (error) {
    if (!isUniqueViolation(error, ACTIVE_CONSTRAINT)) throw error;
    const winner = await latestMaintenanceRun(db, true);
    if (!winner) throw error;
    return {
      runId: parseShortcodeFor("run", winner.shortcode),
      existing: true,
    };
  }
  await launchWorkflowRun(db, { runId, purpose: "maintenance" });
  const shortcode = await readRunShortcode(db, runId);
  if (!shortcode)
    throw new Error(`Maintenance Run ${runId} vanished on launch`);
  return { runId: parseShortcodeFor("run", shortcode), existing: false };
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
