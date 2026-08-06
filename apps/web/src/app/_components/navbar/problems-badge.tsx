import {
  countProblems,
  PROBLEM_CLASS,
  type ProblemKey,
  type ProblemsCount,
} from "@cubby/schemas/problems";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { useProblemsData } from "~/app/problems/use-problems-data";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useHydrated } from "~/hooks/useHydrated";
import { useIdle } from "~/hooks/useIdle";
import { cn } from "~/lib/utils";

const pl = (n: number, sing: string, plur = `${sing}s`) =>
  `${n} ${n === 1 ? sing : plur}`;

// One tooltip phrase per `byType` key, in Problems-page section order. A Record
// (not a list) so adding a category to the count schema is a *compile error*
// here until its phrase is added. Object insertion order drives the tooltip
// order. Coverage-classed keys keep a phrase (the Record must stay exhaustive)
// but are filtered out at render, so the breakdown still sums to `total`.
const PROBLEM_LABELS: Record<
  keyof ProblemsCount["byType"],
  (n: number) => string
> = {
  duplicateInventory: (n) => pl(n, "duplicate"),
  duplicateProductIdentities: (n) => pl(n, "duplicate product"),
  orphanedProducts: (n) => `${n} orphaned`,
  productsMissingPrice: (n) => `${n} stocked without a price`,
  unvaluedBucketProducts: (n) => pl(n, "unvalued bucket"),
  soldButStillStocked: (n) => `${n} sold but still stocked`,
  unlinkedExitExpenses: (n) => `${n} sold without a product`,
  negativeExpectedQuantity: (n) => `${n} sold more than bought`,
  toolsUsedOutsideOwnership: (n) => `${n} used before we owned it`,
  productsWithoutMappings: (n) => `${n} without pricing`,
  ingredientsWithPartialCoverage: (n) => `${n} partial coverage`,
  ingredientsWithoutProduct: (n) => `${n} without a product`,
  unusedIngredientsWithProduct: (n) => `${n} unused (has product)`,
  unusedIngredientsWithoutProduct: (n) => `${n} unused`,
  productsWithIslandedMappings: (n) => pl(n, "islanded mapping"),
  emptyLocations: (n) => pl(n, "empty location"),
  staleLocations: (n) => `${n} overdue for a recount`,
  neverVerifiedInventory: (n) => pl(n, "never-verified item"),
  unknownParkedItems: (n) => `${n} parked in Unknown`,
  manufacturerSpellingVariants: (n) => pl(n, "manufacturer spelling"),
  duplicateVendors: (n) => pl(n, "duplicate vendor"),
  vendorsWithoutLogos: (n) => pl(n, "vendor without a mini logo"),
  productsWithNoImages: (n) => pl(n, "missing image"),
  locationsWithoutAiDescription: (n) => pl(n, "missing AI description"),
  orphanedEntityEmbeddings: (n) => pl(n, "orphaned embedding"),
  entitiesMissingEmbeddings: (n) => `${n} missing a search embedding`,
  staleParentRecipes: (n) => pl(n, "deleted sub-recipe reference"),
  productsWithBetterUpcData: (n) => pl(n, "UPC update"),
  overdueTasks: (n) => pl(n, "overdue task"),
  blockedWorkProjects: (n) => `${n} blocked with no next action`,
  stalledProjects: (n) => pl(n, "stalled project"),
  pastDuePlannedExpenses: (n) => `${n} planned expense past due`,
  projectsMissingBudget: (n) => `${n} missing a cost estimate`,
  unclassifiedExpenses: (n) => pl(n, "unclassified expense"),
  projectsWithDateDrift: (n) => pl(n, "date window drift"),
  // Advisory, so it's filtered out of the tooltip at render like the coverage
  // keys — the phrase exists only to keep this Record exhaustive.
  purchasesNotReconciling: (n) =>
    `${n} stated total${n === 1 ? "" : "s"} need review`,
  purchaseFinancialSettlementMismatches: (n) => `${n} settlement mismatch`,
  duplicateSpendCandidates: (n) =>
    `${n} possible duplicate expense${n === 1 ? "" : "s"}`,
  duplicateFinancialTransactionSourceRefs: (n) =>
    `${n} duplicate transaction reference`,
  duplicateFinancialAccountSourceAliases: (n) => `${n} duplicate account alias`,
  invalidFinancialJson: (n) => `${n} invalid financial record`,
  referentialLivenessViolations: (n) => pl(n, "dangling reference"),
};

export const ProblemsBadge = () => {
  const hydrated = useHydrated();
  // Defer the detector invocations until the browser is idle — the badge
  // renders on every page, so firing them on each navigation put them on the
  // critical path app-wide. `useIdle` holds the fetch until after first paint.
  const idle = useIdle();

  // Assemble the count from the SAME cost-grouped detector queries the
  // Problems page uses (shared cache → no second scan, and the page is already
  // warm when opened). 5-min staleTime keeps this background indicator from
  // refetching on every navigation. Replaces the old monolithic getAllProblems,
  // which ran every detector in one Worker invocation (the CPU-limit risk).
  const { problems, isLoading } = useProblemsData({
    staleTime: 5 * 60 * 1000,
    enabled: hydrated && idle,
  });
  const count = countProblems(problems);

  // The query isn't prefetched during SSR, so the server always renders this
  // loading button. Dehydrated data can resolve before hydration, so gate the
  // loaded branch on `hydrated` too — otherwise the first client render would
  // emit the <Link> while the server emitted this button (hydration mismatch).
  // `!idle` keeps the spinner up until the deferred fetch starts (a disabled
  // query reports isLoading=false with empty data, which would flash "no
  // problems" prematurely).
  if (!hydrated || !idle || isLoading) {
    return (
      <Button variant="ghost" size="sm" disabled className="h-8 px-2">
        <Spinner />
      </Button>
    );
  }

  const totalProblems = count.total;
  const hasProblems = totalProblems > 0;

  // One phrase per category, in Problems-page section order, so the breakdown
  // sums to `total` (every byType key is listed — no silent omissions).
  const tooltipParts = Object.entries(PROBLEM_LABELS).flatMap(
    ([key, phrase]) => {
      // Coverage keys are in `byType` (per-detector consumers still want them)
      // but NOT in `total`, so listing them here would break the "breakdown sums
      // to the badge" contract the Record above exists to guarantee.
      if (PROBLEM_CLASS[key as ProblemKey] !== "defect") return [];
      const n = count.byType[key as keyof ProblemsCount["byType"]];
      return n > 0 ? [phrase(n)] : [];
    },
  );

  const tooltipText = hasProblems
    ? `${tooltipParts.join(", ")} — Click to view`
    : "No problems detected";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 px-2 font-medium",
              !hasProblems && "text-muted-foreground",
              hasProblems && "text-accent-foreground",
            )}
            render={<Link to="/problems" />}
            nativeButton={false}
            aria-label={tooltipText}
          />
        }
      >
        {hasProblems ? (
          <span className="flex items-center gap-1 text-sm">
            <AlertTriangle className="size-4" />
            {totalProblems}
          </span>
        ) : (
          <Check className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  );
};
