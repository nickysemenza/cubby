import {
  EMPTY_PROBLEM_ARRAYS,
  EMPTY_SECTION_TOTALS,
  type ProblemArrays,
  sumProblemSections,
} from "@cubby/schemas/problems";
import { useQueries } from "@tanstack/react-query";
import { useTRPC } from "~/integrations/trpc/react";
import type { ProblemsHotPathProcedure } from "~/lib/problems-query-groups";

/**
 * Loads the Problems page data as four cost-grouped tRPC queries instead of one
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
  // `staleTime` lets the navbar badge reuse this exact cache with a relaxed
  // 5-min freshness (background indicator) while the page leaves it at the
  // client default and revalidates on entry — same query keys, one shared scan.
  // `enabled` lets the homepage card gate the fetch (SSR-idle, then enable on
  // the client) to avoid a hydration mismatch, like the sibling stat cards.
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
      const { sectionTotals: viewTotals, ...viewSections } = views.data ?? {};
      // Each group's own shape supplies its keys, so a group that hasn't
      // resolved yet falls through to the derived empties rather than to 42
      // hand-written `?? []` defaults that a new detector would have to be
      // added to. A resolved group overwrites every key it owns, so the four
      // spreads are exhaustive once all four have loaded.
      const sections: ProblemArrays = {
        ...EMPTY_PROBLEM_ARRAYS,
        ...fast.data,
        ...viewSections,
        ...coverage.data,
        ...upc.data,
        ...tracker.data,
      };
      const results = [fast, views, coverage, upc, tracker];
      // A view-backed section renders a PAGE, so its `items.length` is the page
      // size. Every count below has to read the declared total instead, or a
      // 212-row backlog reports as 12. Falls back to the shared frozen empty
      // while the group loads, so a not-yet-resolved query can't churn the
      // memos downstream (same reason as `EMPTY_PROBLEM_ARRAYS`).
      const sectionTotals = viewTotals ?? EMPTY_SECTION_TOTALS;
      return {
        problems: {
          ...sections,
          sectionTotals,
          // Defect sections only — must match `assembleAllProblems`, hence the
          // shared helper rather than a second local sum.
          totalProblems: sumProblemSections(sections, "defect", sectionTotals),
        },
        coverageTotal: sumProblemSections(sections, "coverage", sectionTotals),
        isLoading: results.some((r) => r.isLoading),
        error: results.find((r) => r.error)?.error ?? null,
      };
    },
  });
}
