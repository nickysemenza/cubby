import {
  EMPTY_PROBLEM_ARRAYS,
  EMPTY_SECTION_TOTALS,
  type ProblemArrays,
  sumProblemSections,
} from "@cubby/schemas/problems";
import { useQueries } from "@tanstack/react-query";
import type { ProblemExecutionLane } from "~/entities/problem-query";
import { useTRPC } from "~/integrations/trpc/react";
import type { ProblemsHotPathProcedure } from "~/lib/problems-query-groups";
import type { ProblemLaneState } from "./problem-lane-state";

/**
 * Loads the Problems page data as five cost-grouped tRPC queries instead of one
 * `getAllProblems` scan. Each group is routed through the unbatched link (see
 * root-provider.tsx), so it runs in its own Worker invocation / CPU budget —
 * the combined scan re-parsed every recipe line through WASM and intermittently
 * blew the 30s CPU limit. (The two WASM parse-sweeps it used to include now live
 * as manual Settings → Maintenance actions, off this hot path.)
 *
 * The four group results are merged back into the same `AllProblems` shape the
 * section renderers expect (missing groups default to empty arrays while they
 * load), with `totalProblems` re-derived via the shared `sumProblemSections` —
 * DEFECT sections only, matching `assembleAllProblems`. Coverage sections (see
 * `PROBLEM_CLASS`) are summed separately into `coverageTotal`; folding them into
 * one number is what made the badge permanently red and unactionable. Uses
 * `useQueries` + `combine` for a referentially-stable result (per the repo's
 * hook-stability rule — a raw `useQueries` array is a new ref every render).
 */
export function useProblemsData(opts?: {
  staleTime?: number;
  enabled?: boolean;
}) {
  const api = useTRPC();
  // `staleTime` lets embedded Problems consumers choose their own freshness;
  // the page revalidates on entry. `enabled` lets the homepage card gate the
  // fetch (SSR-idle, then enable on the client) to avoid a hydration mismatch,
  // like the sibling stat cards. The navbar badge now uses getCounts directly.
  const staleTime = opts?.staleTime;
  const enabled = opts?.enabled;
  const problemGroupQueries = {
    getFast: { ...api.problems.getFast.queryOptions(), staleTime, enabled },
    getViews: { ...api.problems.getViews.queryOptions(), staleTime, enabled },
    getCoverage: {
      ...api.problems.getCoverage.queryOptions(),
      staleTime,
      enabled,
    },
    getUpc: { ...api.problems.getUpc.queryOptions(), staleTime, enabled },
    getTracker: {
      ...api.problems.getTracker.queryOptions(),
      staleTime,
      enabled,
    },
  } satisfies Record<ProblemsHotPathProcedure, unknown>;
  return useQueries({
    queries: [
      problemGroupQueries.getFast,
      problemGroupQueries.getViews,
      problemGroupQueries.getCoverage,
      problemGroupQueries.getUpc,
      problemGroupQueries.getTracker,
    ],
    combine: ([fast, views, coverage, upc, tracker]) => {
      // The views group carries its section rows alongside the totals that
      // describe them; only the rows belong in `sections`.
      const { sectionTotals: fastTotals, ...fastSections } = fast.data ?? {};
      const { sectionTotals: viewTotals, ...viewSections } = views.data ?? {};
      const {
        sectionTotals: coverageTotals,
        freshness: conversionCoverageFreshness,
        ...coverageSections
      } = coverage.data ?? {};
      const {
        sectionTotals: upcTotals,
        freshness: upcFreshness,
        ...upcSections
      } = upc.data ?? {};
      const { sectionTotals: trackerTotals, ...trackerSections } =
        tracker.data ?? {};
      // Each group's own shape supplies its keys, so a group that hasn't
      // resolved yet falls through to the derived empties rather than to 42
      // hand-written `?? []` defaults that a new detector would have to be
      // added to. A resolved group overwrites every key it owns, so the four
      // spreads are exhaustive once all five have loaded.
      const sections: ProblemArrays = {
        ...EMPTY_PROBLEM_ARRAYS,
        ...fastSections,
        ...viewSections,
        ...coverageSections,
        ...upcSections,
        ...trackerSections,
      };
      const results = [fast, views, coverage, upc, tracker];
      const laneResults = {
        fast,
        views,
        coverage,
        upc,
        tracker,
      } satisfies Record<ProblemExecutionLane, (typeof results)[number]>;
      const laneStates = Object.fromEntries(
        Object.entries(laneResults).map(([lane, result]) => [
          lane,
          {
            loaded: result.data != null,
            isLoading: result.isLoading,
            error: result.error ?? null,
          },
        ]),
      ) as Record<ProblemExecutionLane, ProblemLaneState>;
      // A view-backed section renders a PAGE, so its `items.length` is the page
      // size. Every count below has to read the declared total instead, or a
      // 212-row backlog reports as 12. Falls back to the shared frozen empty
      // while the group loads, so a not-yet-resolved query can't churn the
      // memos downstream (same reason as `EMPTY_PROBLEM_ARRAYS`).
      const sectionTotals =
        fastTotals || viewTotals || coverageTotals || upcTotals || trackerTotals
          ? {
              ...fastTotals,
              ...viewTotals,
              ...coverageTotals,
              ...upcTotals,
              ...trackerTotals,
            }
          : EMPTY_SECTION_TOTALS;
      return {
        problems: {
          ...sections,
          sectionTotals,
          upcFreshness,
          conversionCoverageFreshness,
          // Defect sections only — must match `assembleAllProblems`, hence the
          // shared helper rather than a second local sum.
          totalProblems: sumProblemSections(sections, "defect", sectionTotals),
        },
        coverageTotal: sumProblemSections(sections, "coverage", sectionTotals),
        isLoading: results.some((r) => r.isLoading),
        hasResolvedLane: results.some((r) => r.data != null),
        laneStates,
        error: results.find((r) => r.error)?.error ?? null,
      };
    },
  });
}
