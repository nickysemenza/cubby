import type { AllProblems } from "@cubby/schemas/problems";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { useMemo, useRef, useState } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { problems as problemOperations } from "~/lib/problems.functions";

import { AutoFixButton, useAutoFixPlan } from "./components/auto-fix-button";
import { AUTO_FIX_SECTION_IDS } from "./components/auto-fix-registry";
import { AwaitingWorkCard } from "./components/awaiting-work-card";
import { MaintenanceCard } from "./components/maintenance-card";
import { PROBLEM_SECTIONS } from "./components/problem-sections";
import { RecipeUsageContext } from "./components/recipe-usage-context";
import { problemSectionLaneState } from "./problem-lane-state";
import { useProblemsData } from "./use-problems-data";

/**
 * Scroll to a node that may not be laid out yet.
 *
 * A section revealed by opening the collapsed group mounts *before* it has any
 * height — Base UI animates the panel open, and `scrollIntoView` on a zero-height
 * node is a silent no-op, which is exactly how the chip ended up doing nothing.
 * Wait for real layout, bounded so a permanently-hidden node can't spin frames.
 */
function scrollWhenLaidOut(el: HTMLElement, framesLeft = 20) {
  if (el.offsetHeight > 0) {
    el.scrollIntoView({ behavior: "smooth" });
    return;
  }
  if (framesLeft <= 0) return;
  requestAnimationFrame(() => scrollWhenLaidOut(el, framesLeft - 1));
}

// Three disjoint lists. Coverage is checked FIRST so a coverage section can't
// also fall into the main list (`images` is coverage and has a fix-all button,
// but isn't one of the Fix button's auto-fix tasks).
const COVERAGE_SECTIONS = PROBLEM_SECTIONS.filter((s) => s.coverage != null);
const MAIN_SECTIONS = PROBLEM_SECTIONS.filter(
  (section) =>
    section.coverage == null && !AUTO_FIX_SECTION_IDS.has(section.id),
);
const AUTO_FIXABLE_SECTIONS = PROBLEM_SECTIONS.filter(
  (section) => section.coverage == null && AUTO_FIX_SECTION_IDS.has(section.id),
);

export function ProblemsOverview() {
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Sections the Fix button clears live in a collapsed group, so a chip pointing
  // at one has to open the group before it can scroll. Opening isn't enough to
  // scroll in the same pass: Base UI mounts the panel's children a beat after
  // `open` flips, so an effect keyed on the click sees a null ref, silently
  // no-ops, and the chip does nothing. Park the id in a REF instead and let the
  // section's own ref callback scroll the moment its node lands — exact, with no
  // polling and no stale closure over the pending id.
  const [autoFixOpen, setAutoFixOpen] = useState(false);
  const pendingScrollId = useRef<string | null>(null);

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
  // recipe usage once for the whole page rather than per card. Keyed by
  // shortcode because that is the only id the cards themselves carry.
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

  const scrollToSection = (id: string, grouped: boolean) => {
    const mounted = sectionRefs.current[id];
    if (mounted) {
      scrollWhenLaidOut(mounted);
      return;
    }
    // Not in the DOM yet ⇒ it's inside the collapsed group. Open it and let the
    // ref callback below finish the job once the panel mounts.
    pendingScrollId.current = id;
    if (grouped) setAutoFixOpen(true);
  };

  const renderSection = (section: (typeof PROBLEM_SECTIONS)[number]) => (
    <div
      key={section.id}
      ref={(el) => {
        sectionRefs.current[section.id] = el;
        if (el && pendingScrollId.current === section.id) {
          pendingScrollId.current = null;
          scrollWhenLaidOut(el);
        }
      }}
    >
      {(() => {
        const state = problemSectionLaneState(
          section.problemKeys ?? [],
          laneStates,
        );
        if (state.state === "error") {
          // Keep the section's identity. A bare ErrorDisplay replaced the whole
          // card, so a failed lane left an anonymous red box where a named
          // check used to be — you couldn't tell WHICH check was missing, only
          // that something was.
          return (
            <Card>
              <CardHeader>
                <CardTitle>
                  <WarningIcon className="size-5 text-destructive" />
                  {section.label}
                </CardTitle>
                <CardDescription>
                  This check couldn't run, so its rows aren't included in the
                  totals above.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ErrorDisplay error={state.error} />
              </CardContent>
            </Card>
          );
        }
        if (state.state === "loading") {
          return <SimpleLoading text={`Checking ${section.label}…`} />;
        }
        return section.node(problems, coverageTotals);
      })()}
    </div>
  );

  return (
    <RecipeUsageContext.Provider value={recipeUsage ?? {}}>
      <Stack gap="lg">
        <ProblemsSummary
          problems={problems}
          analyzing={detectorsLoading}
          onJump={scrollToSection}
        />

        {problems.upcFreshness?.status !== "fresh" &&
          problems.upcFreshness != null && (
            <output className="block border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-ink">
              {problems.upcFreshness.status === "stale"
                ? "UPC provider is unavailable; showing the last cached proposals."
                : "UPC provider is unavailable; proposals will return when it recovers."}
            </output>
          )}

        {problems.conversionCoverageFreshness?.state !== "fresh" &&
          problems.conversionCoverageFreshness != null && (
            <output className="block border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-ink">
              {problems.conversionCoverageFreshness.state === "unavailable"
                ? "Conversion coverage is partially unavailable; exact product worklists omit unavailable rows until enrichment recovers."
                : "Conversion coverage is stale; exact product worklists omit stale rows until the projection is rebuilt."}
            </output>
          )}

        {MAIN_SECTIONS.map(renderSection)}

        {/* Everything the Fix button clears, folded away: one click empties
            these, so they'd otherwise be a wall of rows nobody has to read. */}
        <AutoFixableGroup
          problems={problems}
          open={autoFixOpen}
          onOpenChange={setAutoFixOpen}
        >
          {AUTO_FIXABLE_SECTIONS.map(renderSection)}
        </AutoFixableGroup>

        {/* Backlog and advisory cues, not defects. Kept on this page (it's the
            same housekeeping headspace) but below the issues and visually
            distinct: these never reach zero, so counting them as problems is
            what made the badge permanently red and taught everyone to ignore
            it. */}
        <Section
          title="Coverage & cues"
          description="How much of the house has been itemized, photographed and counted, plus soft cues that are often correct as they stand. These don't reach zero — new things arrive faster than they get filed — so they're progress and prompts, not problems."
        >
          {COVERAGE_SECTIONS.map(renderSection)}
        </Section>

        {/* Derived work still waiting on a queue wakeup, then the one-off tools —
            surfaced here (not just buried in Settings) so the "fix it" affordances
            live right next to the issues. Same shared cards as Settings →
            Developer / Maintenance, same mutations. */}
        <AwaitingWorkCard />
        <MaintenanceCard />
      </Stack>
    </RecipeUsageContext.Provider>
  );
}

/**
 * The headline card. The total is decomposed rather than shown alone: a bare
 * four-digit number reads as an indictment, while "N issues · M auto-fixable"
 * tells you how much of it is actually yours to do.
 */
function ProblemsSummary({
  problems,
  analyzing,
  onJump,
}: {
  problems: AllProblems;
  analyzing: boolean;
  onJump: (id: string, grouped: boolean) => void;
}) {
  // `listedItems`, not `items` — only the part of the run that's actually among
  // the issues counted above can be described as "N of them".
  const { listedItems } = useAutoFixPlan(problems);

  if (problems.totalProblems === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {analyzing ? (
              <Spinner />
            ) : (
              <CheckCircleIcon className="size-5 text-secondary-foreground" />
            )}
            {analyzing ? "Analyzing data consistency…" : "All Good!"}
          </CardTitle>
          <CardDescription>
            {analyzing
              ? "Completed checks will appear below while the remaining lanes run."
              : "All data consistency checks passed. No issues found."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Both the summary chips and the section list derive from PROBLEM_SECTIONS,
  // so each check is declared exactly once (see ./components/problem-sections).
  // Coverage sections are excluded: this card counts issues, and their rows
  // aren't issues — they'd also swamp the chip row, being the bulk of the page.
  const chips = PROBLEM_SECTIONS.filter((s) => s.coverage == null)
    .map((section) => ({
      id: section.id,
      label: section.label,
      count: section.count(problems),
      grouped: AUTO_FIX_SECTION_IDS.has(section.id),
    }))
    .filter((cat) => cat.count > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <Row align="start" justify="between" gap="md">
          <Stack gap="tight">
            <CardTitle>
              <Badge variant="destructive" className="text-base">
                {problems.totalProblems}
              </Badge>
              {problems.totalProblems === 1 ? "Issue" : "Issues"} Found
            </CardTitle>
            {listedItems > 0 && (
              <CardDescription>
                {listedItems} of them need no decisions from you.
              </CardDescription>
            )}
            {analyzing && (
              <CardDescription>More checks are still running.</CardDescription>
            )}
          </Stack>
          <AutoFixButton problems={problems} />
        </Row>
        <Row gap="sm" wrap className="pt-2">
          {chips.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => onJump(cat.id, cat.grouped)}
              className="inline-flex items-center gap-2 bg-muted px-2 py-1 text-sm transition-colors hover:bg-muted/80"
            >
              {cat.label}
              <Badge
                variant={cat.grouped ? "secondary" : "destructive"}
                className="ml-1"
              >
                {cat.count}
              </Badge>
            </button>
          ))}
        </Row>
      </CardHeader>
    </Card>
  );
}

function AutoFixableGroup({
  problems,
  open,
  onOpenChange,
  children,
}: {
  problems: AllProblems;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const total = AUTO_FIXABLE_SECTIONS.reduce(
    (n, s) => n + s.count(problems),
    0,
  );
  if (total === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border border-border px-4 py-2 text-left text-sm transition-colors hover:bg-muted/50">
        <CaretRightIcon
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-medium">Auto-fixable</span>
        <Badge variant="secondary">{total}</Badge>
        <span className="text-muted-foreground">
          cleared by the Fix button — no decisions needed
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="lg" className="pt-4">
          {children}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}
