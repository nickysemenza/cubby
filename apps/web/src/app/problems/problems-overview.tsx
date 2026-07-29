import type { AllProblems, CoverageTotals } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { CheckCircle, ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { useTRPC } from "~/integrations/trpc/react";
import { AutoFixButton, useAutoFixPlan } from "./components/auto-fix-button";
import { MaintenanceCard } from "./components/maintenance-card";
import { PROBLEM_SECTIONS } from "./components/problem-sections";
import { RecipeUsageContext } from "./components/recipe-usage-context";
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

const MAIN_SECTIONS = PROBLEM_SECTIONS.filter((s) => s.group == null);
const AUTO_FIXABLE_SECTIONS = PROBLEM_SECTIONS.filter(
  (s) => s.group === "autoFixable",
);
const COVERAGE_SECTIONS = PROBLEM_SECTIONS.filter(
  (s) => s.group === "coverage",
);

/** Denominators default to 0 while the (separate, cheap) query is in flight. */
const NO_COVERAGE_TOTALS: CoverageTotals = {
  productsWithNoImages: 0,
  emptyLocations: 0,
  staleLocations: 0,
  neverVerifiedInventory: 0,
  ingredientsWithoutProduct: 0,
};

export function ProblemsOverview() {
  const api = useTRPC();
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
  // into the AllProblems shape the sections expect. No staleTime: opening the
  // page revalidates whatever the badge's 5-min cache may have left stale.
  const { problems, isLoading, error } = useProblemsData();

  // Every product id across the product-bearing sections, so we fetch recipe
  // usage once for the whole page rather than per card.
  const productIds = useMemo(
    () =>
      problems
        ? uniq(
            [
              ...problems.duplicateUniqueProducts,
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
    api.problems.recipeUsageByProduct.queryOptions({ productIds }),
  );

  // Denominators for the coverage meters. Its own cheap batched query — the
  // meters are page-only, so this stays off the four unbatched hot-path groups.
  const { data: coverageTotals = NO_COVERAGE_TOTALS } = useQuery(
    api.problems.getCoverageTotals.queryOptions(),
  );

  if (isLoading) {
    return <SimpleLoading text="Analyzing data consistency..." />;
  }

  if (error) {
    return (
      <ErrorDisplay
        error={error}
        className="rounded-md bg-destructive/10 p-4"
      />
    );
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
      {section.node(problems, coverageTotals)}
    </div>
  );

  return (
    <RecipeUsageContext.Provider value={recipeUsage ?? {}}>
      <Stack gap="lg">
        <ProblemsSummary problems={problems} onJump={scrollToSection} />

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

        {/* Backlog, not defects. Kept on this page (it's the same housekeeping
            headspace) but below the issues and visually distinct: these never
            reach zero, so counting them as problems is what made the badge
            permanently red and taught everyone to ignore it. */}
        <Section
          title="Coverage"
          description="How much of the house has been itemized, photographed and counted. These don't reach zero — new things arrive faster than they get filed — so they're progress, not problems."
        >
          {COVERAGE_SECTIONS.map(renderSection)}
        </Section>

        {/* Force-run batch fixes — surfaced here (not just buried in Settings)
            so the "fix it" tools live right next to the issues. Same shared card
            as Settings → Developer / Maintenance, same mutations. */}
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
  onJump,
}: {
  problems: AllProblems;
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
            <CheckCircle className="size-5 text-secondary-foreground" />
            All Good!
          </CardTitle>
          <CardDescription>
            All data consistency checks passed. No issues found.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Both the summary chips and the section list derive from PROBLEM_SECTIONS,
  // so each check is declared exactly once (see ./components/problem-sections).
  // Coverage sections are excluded: this card counts issues, and their rows
  // aren't issues (they'd also swamp the chip row — they're the bulk of the
  // page). `grouped` means "inside the collapsed auto-fix panel", which is what
  // decides whether jumping to it has to open that panel first — so it tracks
  // that one group specifically, not merely "has a group".
  const chips = PROBLEM_SECTIONS.filter((s) => s.group !== "coverage")
    .map((section) => ({
      id: section.id,
      label: section.label,
      count: section.count(problems),
      grouped: section.group === "autoFixable",
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
          </Stack>
          <AutoFixButton problems={problems} />
        </Row>
        <Row gap="sm" wrap className="pt-2">
          {chips.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => onJump(cat.id, cat.grouped)}
              className="inline-flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-sm transition-colors hover:bg-muted/80"
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
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md border border-border px-4 py-2 text-left text-sm transition-colors hover:bg-muted/50">
        <ChevronRight
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
