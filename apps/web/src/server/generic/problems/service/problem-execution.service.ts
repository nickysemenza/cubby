import { isProjectAttentionProblemKey } from "@cubby/schemas/problems-raw-read";
import type { ProblemKey } from "@cubby/schemas/problems-raw-read";
import type { ProjectAttentionIncompleteIds } from "@cubby/schemas/project";

import type { ProblemSource } from "~/entity/problems/problem-query";
import { problemQuery } from "~/entity/problems/problem-registry";
import type { Database } from "~/server/db";
import type { ProductConversionCoverageFreshness } from "~/server/domains/product/repo/conversion-coverage";
import type { UsdaFoodBatchPort } from "~/server/domains/usda-food/repo/usda-helpers";
import {
  runDiagnostic,
  type DiagnosticRunOptions,
  type UpcLookupBatchPort,
} from "~/server/generic/problems/service/problem-diagnostics.service";

export const PROBLEM_SAMPLE_SIZE = 12;
export type ListRow = { id: string };
export type ProblemRunStatus =
  | { state: "healthy" }
  | {
      state: "stale";
      message: string;
      projection?: ProductConversionCoverageFreshness;
    }
  | {
      state: "unavailable";
      message: string;
      projection?: ProductConversionCoverageFreshness;
    };

/** The exact count describes the population, never the selected rows' length. */
export type ProblemRunResult = {
  data: ListRow[];
  items: readonly unknown[];
  count: number;
  source: ProblemSource;
  status: ProblemRunStatus;
  freshness?: Awaited<ReturnType<typeof runDiagnostic>>["freshness"];
};

export type ProblemRunOptions = {
  mode?: "sample" | "count";
  pageIndex?: number;
  sampleSize?: number;
  diagnostic?: DiagnosticRunOptions;
  projectionFreshness?: ProductConversionCoverageFreshness;
  fields?: readonly string[];
};

/**
 * Run a registered Problem through its one canonical source declaration.
 * Entity membership compiles to the ordinary list path; derived membership is
 * delegated only by typed DiagnosticKey, never a callback in the manifest.
 */
export const executeProblem = async (
  db: Database,
  key: ProblemKey,
  options: ProblemRunOptions = {},
): Promise<ProblemRunResult> => {
  const definition = problemQuery(key);
  if (!definition) throw new Error(`No registered Problem declares "${key}"`);
  if (definition.source.kind === "derived") {
    const offset =
      (options.pageIndex ?? 0) * (options.sampleSize ?? PROBLEM_SAMPLE_SIZE);
    const diagnostic =
      options.mode === "count"
        ? await runDiagnostic(
            db,
            definition.source.diagnostic,
            options.diagnostic ?? {},
            { kind: "count" },
          )
        : await runDiagnostic(
            db,
            definition.source.diagnostic,
            options.diagnostic,
            {
              kind: "sample",
              limit: offset + (options.sampleSize ?? PROBLEM_SAMPLE_SIZE),
            },
          );
    const items =
      "items" in diagnostic && Array.isArray(diagnostic.items)
        ? diagnostic.items.slice(
            offset,
            offset + (options.sampleSize ?? PROBLEM_SAMPLE_SIZE),
          )
        : [];
    return {
      // Derived rows intentionally have no common list row contract. Keeping
      // this empty prevents entity presenters from treating a pair/group as an
      // entity; consumers use `items` and the declared grain instead.
      data: [],
      items,
      count: diagnostic.count,
      source: definition.source,
      status: diagnostic.status,
      freshness: diagnostic.freshness,
    };
  }
  return (
    await import("~/server/generic/problems/service/problem-views.service")
  ).executeEntityProblem(db, key, options);
};

/** Focused derived reads do not initialize entity presenters or maintenance writers. */
export const findProblemByType = async (
  db: Database,
  key: ProblemKey,
  upcLookupClient: UpcLookupBatchPort,
  usdaClient: UsdaFoodBatchPort,
): Promise<{
  type: ProblemKey;
  items: unknown[];
  total: number;
  incompleteProjectIds?: ProjectAttentionIncompleteIds;
}> => {
  const definition = problemQuery(key);
  if (!definition) throw new Error(`No registered Problem declares "${key}"`);
  if (isProjectAttentionProblemKey(key))
    return (
      await import("~/server/generic/problems/service/problems.service")
    ).findEntityProblemByType(db, key, upcLookupClient, usdaClient);
  if (definition.source.kind === "derived") {
    const result = await executeProblem(db, key, {
      diagnostic: { upcLookupClient },
    });
    return { type: key, items: [...result.items], total: result.count };
  }
  return (
    await import("~/server/generic/problems/service/problems.service")
  ).findEntityProblemByType(db, key, upcLookupClient, usdaClient);
};
