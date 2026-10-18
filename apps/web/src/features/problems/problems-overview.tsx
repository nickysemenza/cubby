import { isAutoFixProblemKey } from "@cubby/schemas/problems";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { type ReactNode, useMemo } from "react";

import { problems as problemOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { RecordDot, RecordList, RecordRow } from "~/ui/common/record-list";
import {
  IndexedSections,
  type IndexedSection,
  type IndexedSectionGroup,
} from "~/ui/data-table/indexed-sections";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/ui/primitives/collapsible";
import { Spinner } from "~/ui/primitives/spinner";

import { AutoFixButton } from "./components/auto-fix-button";
import { MaintenanceRunCard } from "./components/maintenance-run-card";
import { MaintenanceTools } from "./components/maintenance-tools";
import { ProblemImagesProvider } from "./components/problem-images";
import type { ProblemSectionKind } from "./components/problem-section";
import {
  PROBLEM_SECTIONS,
  type ProblemSectionEntry,
} from "./components/problem-sections";
import { RecipeUsageContext } from "./components/recipe-usage-context";
import { problemSectionLaneState } from "./problem-lane-state";
import { useProblemsData } from "./use-problems-data";

type Entry = (typeof PROBLEM_SECTIONS)[number];

// A defect section is auto-fixable when the Fix button clears every key it
// renders. Three disjoint lists; coverage is checked first so a coverage
// section can't also land in a defect group.
const isAutoFixSection = (section: Entry) =>
  section.coverage == null && section.problemKeys.every(isAutoFixProblemKey);
const NEEDS_YOU_SECTIONS = PROBLEM_SECTIONS.filter(
  (section) => section.coverage == null && !isAutoFixSection(section),
);
const AUTO_FIX_SECTIONS = PROBLEM_SECTIONS.filter(isAutoFixSection);
const COVERAGE_SECTIONS = PROBLEM_SECTIONS.filter(
  (section) => section.coverage != null,
);

export function ProblemsOverview() {
  // The page loads detectors as five cost-grouped, unbatched queries (each its
  // own Worker invocation/CPU budget — see useProblemsData) and merges them back
  // into the AllProblems shape the sections expect. The hook keeps results warm
  // for five minutes; successful repairs explicitly invalidate them.
  const {
    problems,
    isLoading: detectorsLoading,
    hasResolvedLane,
    laneStates,
    error,
  } = useProblemsData();
  // Hydration-stable: the server renders this branch with no detector results,
  // while the client's first render already has them. See useHydratedLoading.
  const isLoading = useHydratedLoading(detectorsLoading && !hasResolvedLane);

  // Every product shortcode across the product-bearing sections, so we fetch
  // recipe usage once for the whole page rather than per row. Keyed by
  // shortcode because that is the only id the rows themselves carry.
  const productShortcodes = useMemo(
    () =>
      problems
        ? uniq(
            [
              ...problems.duplicateInventory,
              ...problems.orphanedProducts,
              ...problems.productsMissingPrice,
              ...problems.unvaluedBucketProducts,
              ...problems.productsWithoutMappings,
              ...problems.ingredientsWithPartialCoverage,
              ...problems.productsWithIslandedMappings,
              ...problems.productsWithNoImages,
              ...problems.productsWithBetterUpcData,
            ].map((p) => p.id),
          )
        : [],
    [problems],
  );
  const { data: recipeUsage } = useQuery(
    problemOperations.recipeUsageByProduct.queryOptions({ productShortcodes }),
  );

  // Denominators for the coverage meters. Its own cheap batched query — the
  // meters are page-only, so this stays off the five unbatched hot-path groups.
  //
  // Deliberately NOT folded into the `isLoading` gate below, and deliberately
  // left `undefined` rather than defaulted to zeros: the page shouldn't hold the
  // whole defect list behind a query only the coverage meters need, and a
  // section whose denominators haven't landed simply renders without its meter
  // (see `resolveCoverage`) instead of briefly showing "-178 / 0".
  const { data: coverageTotals } = useQuery(
    problemOperations.getCoverageTotals.queryOptions(),
  );

  if (isLoading) {
    return <SimpleLoading text="Analyzing data consistency…" />;
  }

  if (error && !hasResolvedLane) {
    return <ErrorDisplay error={error} className="bg-destructive/10 p-4" />;
  }

  const passing: Entry[] = [];

  /** One check as an indexed section, or nothing when it passed. */
  const toSection = (
    entry: ProblemSectionEntry,
    kind: ProblemSectionKind,
  ): IndexedSection | null => {
    const base = {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      icon: entry.icon,
    };
    const state = problemSectionLaneState(entry.problemKeys, laneStates);
    if (state.state === "error") {
      // Keep the check's identity: a failed lane still names WHICH check is
      // missing, and says its rows aren't in the totals.
      return {
        ...base,
        description: "This check couldn't run, so its rows aren't counted.",
        content: <ErrorDisplay error={state.error} />,
      };
    }
    if (state.state === "loading") {
      return {
        ...base,
        content: <RecordList state={{ status: "pending" }} />,
      };
    }
    const count = entry.count(problems);
    if (count === 0) {
      if (!entry.hideWhenEmpty) passing.push(entry);
      return null;
    }
    return {
      ...base,
      count,
      headerAction: entry.headerAction?.(problems),
      // Inline fixes open comboboxes that must escape the section plane.
      overflowVisible: true,
      content: entry.node(problems, coverageTotals, kind),
    };
  };

  const sectionsOf = (entries: readonly Entry[], kind: ProblemSectionKind) =>
    entries
      .map((entry) => toSection(entry, kind))
      .filter((section) => section != null);

  const needsYou = sectionsOf(NEEDS_YOU_SECTIONS, "needs-you");
  const autoFix = sectionsOf(AUTO_FIX_SECTIONS, "auto-fix");
  const coverage = sectionsOf(COVERAGE_SECTIONS, "coverage");
  // The headline is the sidebar's own counts summed, so the two can't disagree.
  const total = (sections: IndexedSection[]) =>
    sections.reduce((n, section) => n + (section.count ?? 0), 0);

  const groups: IndexedSectionGroup[] = [
    { id: "needs-you", title: "Needs you", sections: needsYou },
    {
      id: "fixes-automatically",
      title: "Fixes automatically",
      sections: autoFix,
    },
    { id: "coverage-and-cues", title: "Coverage & cues", sections: coverage },
    {
      id: "upkeep",
      title: "Upkeep",
      sections: [
        {
          id: "maintenance",
          title: "Maintenance",
          description:
            "The nightly pass drains every backlog as one Run; Run now starts one.",
          icon: ClockIcon,
          content: <MaintenanceRunCard />,
        },
        {
          id: "repair-tools",
          title: "Repair tools",
          description:
            "Rebuilds derived data on demand. Routine upkeep happens at write time; these are one-off tools.",
          icon: WrenchIcon,
          content: <MaintenanceTools />,
        },
      ],
    },
  ].filter((group) => group.sections.length > 0);

  return (
    <RecipeUsageContext.Provider value={recipeUsage ?? {}}>
      <ProblemsHeadline
        needsYou={total(needsYou)}
        autoFix={total(autoFix)}
        coverage={total(coverage)}
        analyzing={detectorsLoading}
        fix={<AutoFixButton problems={problems} />}
      />
      <ProblemImagesProvider>
        <IndexedSections
          groups={groups}
          footer={<PassingChecks entries={passing} />}
        />
      </ProblemImagesProvider>
    </RecipeUsageContext.Provider>
  );
}

/**
 * The page's figures as inline stats. Split by who resolves them: a bare
 * four-digit total that is mostly search-index backlog reads as an indictment,
 * while "N need you · M fix automatically" says how much is actually yours.
 */
function ProblemsHeadline({
  needsYou,
  autoFix,
  coverage,
  analyzing,
  fix,
}: {
  needsYou: number;
  autoFix: number;
  coverage: number;
  analyzing: boolean;
  fix: ReactNode;
}) {
  const clean = needsYou + autoFix === 0;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {analyzing ? (
          <Spinner aria-hidden className="size-3.5" />
        ) : clean ? (
          <CheckCircleIcon
            aria-hidden
            className="size-4 text-secondary-foreground"
          />
        ) : null}
        {clean && !analyzing ? (
          <span className="text-foreground">Every check passes.</span>
        ) : (
          <>
            <Stat value={needsYou} tone={needsYou > 0 ? "alert" : "plain"} />
            need you
            <span aria-hidden>·</span>
            <Stat value={autoFix} />
            fix automatically
          </>
        )}
        {coverage > 0 && (
          <>
            <span aria-hidden>·</span>
            <Stat value={coverage} />
            coverage gaps
          </>
        )}
        {analyzing && <span>· more checks are still running</span>}
      </p>
      {autoFix > 0 && fix}
    </div>
  );
}

function Stat({
  value,
  tone = "plain",
}: {
  value: number;
  tone?: "plain" | "alert";
}) {
  return (
    <span
      className={cn(
        "font-mono font-semibold tabular-nums",
        tone === "alert" ? "text-destructive" : "text-foreground",
      )}
    >
      {formatCount(value)}
    </span>
  );
}

/**
 * Checks with nothing to report, folded into one line after the sections: worth
 * confirming, but an empty card between real problems is clutter.
 */
function PassingChecks({ entries }: { entries: readonly Entry[] }) {
  if (entries.length === 0) return null;
  return (
    <Collapsible className="border-t border-border pt-2">
      <CollapsibleTrigger className="group flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground max-md:min-h-11">
        <CaretRightIcon
          aria-hidden
          className="size-3 transition-transform group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
        />
        <CheckCircleIcon aria-hidden className="size-3.5" />
        {entries.length} {entries.length === 1 ? "check" : "checks"} passing
      </CollapsibleTrigger>
      <CollapsibleContent>
        <RecordList aria-label="Passing checks" className="mt-1">
          {entries.map((entry) => (
            <RecordRow
              key={entry.id}
              leading={<RecordDot tone="positive" label="Passing" />}
              primary={entry.title}
              secondary={entry.emptyMessage}
            />
          ))}
        </RecordList>
      </CollapsibleContent>
    </Collapsible>
  );
}
