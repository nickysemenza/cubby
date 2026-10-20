import { describeErrorCauses } from "~/lib/error-diagnostics";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";
import type {
  DerivedRefreshPorts,
  DerivedEmbeddingResult,
} from "~/server/generic/derived-refresh/refresh-ports.boundary";
import { processDerivedRefreshPage as processPage } from "~/server/generic/derived-refresh/repo/process";
import { processStatementRetirementPage } from "~/server/generic/derived-refresh/repo/statement-retirement";
import { retryEmbeddingArtifactFailures } from "~/server/generic/embedding/repo/embedding-artifact";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import {
  refreshEntityEmbeddings,
  recoverEmbeddingArtifactsPage,
} from "~/server/workflows/background-tasks/embedding";

export const productionDerivedRefreshPorts: DerivedRefreshPorts = {
  async refreshEmbeddings(db, refs) {
    const results = await refreshEntityEmbeddings(db, refs);
    const mapped = new Map<string, DerivedEmbeddingResult>();
    for (const [key, result] of results) {
      if ("error" in result) {
        if (result.exhausted === undefined) throw result.error;
        const error = JSON.stringify(describeErrorCauses(result.error));
        mapped.set(
          key,
          result.exhausted
            ? { state: "failed", error }
            : { state: "pending", error },
        );
      } else
        mapped.set(
          key,
          result.outcome === "pending" || result.outcome === "obsolete"
            ? { state: "pending" }
            : { state: "ready" },
        );
    }
    return mapped;
  },
  prepareRecipe: (db, id) =>
    new RecipeCostingService(db, {
      findFoodsBatch: (lookups) =>
        new USDAClient(requestUsdaRelease()).findFoodsBatch(lookups),
    }).prepareRefresh(id),
};

/** Domain computation stays outside the repository's short publication transaction. */
export const processDerivedRefreshPage = (
  db: Database,
  ports: DerivedRefreshPorts = productionDerivedRefreshPorts,
  options: { frontierOnly?: boolean } = {},
) => processPage(db, ports, options);

import type { StepRunDrivers } from "~/server/domains/run/service/step-run";
import { retryDerivedRefreshFailures } from "~/server/generic/derived-refresh/repo/process";
import { reconcileDerivedRefreshPage } from "~/server/generic/derived-refresh/repo/reconcile";
import {
  ensureDerivedRefreshRun,
  nextRefreshWake,
} from "~/server/generic/derived-refresh/repo/refresh-run";
import {
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

export const derivedRefreshDrivers: StepRunDrivers = async () => [
  {
    key: "derived-refresh",
    label: "Refresh derived records",
    async page({ db, retrying }) {
      if (retrying) {
        await retryDerivedRefreshFailures(db);
        await retryEmbeddingArtifactFailures(db);
      }
      const statements = await processStatementRetirementPage(db);
      if (!statements.done)
        return {
          kind: "progress",
          done: false,
          delta: { done: statements.processed, failed: 0 },
        };
      const page = await processDerivedRefreshPage(db);
      const artifacts = page.done
        ? await recoverEmbeddingArtifactsPage(db)
        : null;
      if (artifacts?.processed)
        return {
          kind: "progress",
          done: false,
          delta: { done: artifacts.processed, failed: artifacts.errors.length },
          errors: artifacts.errors.map((message) => ({
            at: new Date().toISOString(),
            message,
          })),
        };
      const repair = page.done
        ? await reconcileDerivedRefreshPage(db, {
            embeddingConfig: semanticEmbeddingsConfigured()
              ? getSemanticEmbeddingConfig()
              : undefined,
          })
        : null;
      if (repair && (!repair.done || repair.processed > 0))
        return {
          kind: "progress",
          done: false,
          delta: { done: repair.processed, failed: page.errors.length },
          errors: page.errors.map((message) => ({
            at: new Date().toISOString(),
            message,
          })),
        };
      const retryAt = page.done ? await nextRefreshWake(db) : null;
      if (retryAt)
        return {
          kind: "paused",
          reason: semanticEmbeddingsConfigured()
            ? "Derived refresh retry scheduled"
            : "Embedding provider or Vectorize binding is unavailable",
          until: new Date(
            Math.max(
              retryAt.getTime(),
              Date.now() + (semanticEmbeddingsConfigured() ? 1_000 : 60_000),
            ),
          ),
        };
      return {
        kind: "progress",
        done: page.done && repair?.done === true && repair.processed === 0,
        delta: {
          done: page.processed + (repair?.processed ?? 0),
          failed: page.errors.length,
        },
        errors: page.errors.map((message) => ({
          at: new Date().toISOString(),
          message,
        })),
      };
    },
  },
];

/** Small waves finish on the queue; larger ones use the existing StepRun ledger. */
export async function wakeDerivedRefresh(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const deadline = performance.now() + 5_000;
  for (let pages = 0; pages < 25 && performance.now() < deadline; pages++) {
    const page = await processDerivedRefreshPage(
      db,
      productionDerivedRefreshPorts,
      {
        frontierOnly: true,
      },
    );
    if (page.done) break;
  }
  const run = await ensureDerivedRefreshRun(db);
  if (run?.created)
    await launchWorkflowRun(
      db,
      { runId: run.id, purpose: "derived_refresh", automatic: true },
      launcher,
    );
}
