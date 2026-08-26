import {
  PROBLEM_CLASS,
  type ProblemKey,
  type ProblemsCount,
} from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { problemsCountsQueryOptions } from "~/lib/problems.functions";
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
  partiallyImportedCookbooks: (n) => pl(n, "partially imported cookbook"),
  productsMissingPrice: (n) => `${n} stocked without a price`,
  unvaluedBucketProducts: (n) => pl(n, "unvalued bucket"),
  soldButStillStocked: (n) => `${n} sold but still stocked`,
  kitsCountedTwice: (n) => `${n} ${n === 1 ? "kit" : "kits"} counted twice`,
  unlinkedExitExpenses: (n) => `${n} sold without a product`,
  purchaselessExitExpenses: (n) => `${n} credited without an order`,
  negativeExpectedQuantity: (n) => `${n} sold more than bought`,
  toolsUsedOutsideOwnership: (n) => `${n} used before we owned it`,
  productsWithoutMappings: (n) => `${n} without pricing`,
  ingredientsWithPartialCoverage: (n) => `${n} partial coverage`,
  ingredientsWithoutProduct: (n) => `${n} without a product`,
  unusedIngredientsWithProduct: (n) => `${n} unused (has product)`,
  unusedIngredientsWithoutProduct: (n) => `${n} unused`,
  productsWithIslandedMappings: (n) => pl(n, "islanded mapping"),
  productsWithTitleDerivableSize: (n) => `${n} with a size in the title`,
  emptyLocations: (n) => pl(n, "empty location"),
  staleLocations: (n) => `${n} overdue for a recount`,
  neverVerifiedInventory: (n) => pl(n, "never-verified item"),
  unknownParkedItems: (n) => `${n} parked in Unknown`,
  inventoryWithoutPricePath: (n) => `${n} priced but unvaluable`,
  manufacturerSpellingVariants: (n) => pl(n, "manufacturer spelling"),
  duplicateVendors: (n) => pl(n, "duplicate vendor"),
  vendorsWithoutLogos: (n) => pl(n, "vendor without a mini logo"),
  productsWithNoImages: (n) => pl(n, "missing image"),
  locationsWithoutAiDescription: (n) => pl(n, "missing AI description"),
  orphanedEntityEmbeddings: (n) => pl(n, "orphaned embedding"),
  unreferencedImages: (n) => pl(n, "unreferenced file"),
  entitiesMissingEmbeddings: (n) => `${n} missing a search embedding`,
  staleParentRecipes: (n) => pl(n, "deleted sub-recipe reference"),
  emptyCookedMeals: (n) => pl(n, "cooked meal with nothing planned"),
  understatedCostMeals: (n) => pl(n, "meal with an understated cost"),
  recipesWithoutInstructions: (n) => pl(n, "recipe without instructions"),
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
  financialTransactionAllocationDefects: (n) =>
    pl(n, "broken settlement allocation"),
  invalidFinancialJson: (n) => `${n} invalid financial record`,
  incompleteStatementImports: (n) => `${n} incomplete statement import`,
  referentialLivenessViolations: (n) => pl(n, "dangling reference"),
};

export const ProblemsBadge = () => {
  const { isAuthed } = useRouteContext({ from: "__root__" });

  // Counts are a cheap KV snapshot and share Home's authenticated route
  // context, so this can reuse the server-prefetched result without risking an
  // unauthenticated request.
  const { data: count, isLoading } = useQuery({
    ...problemsCountsQueryOptions({
      staleTime: 5 * 60 * 1000,
      enabled: isAuthed,
    }),
  });

  // A disabled query reports isLoading=false with empty data, so keep the
  // spinner until the authenticated route enables the read and a snapshot
  // arrives.
  if (!isAuthed || isLoading || !count) {
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
  const accessibleName = hasProblems
    ? `${totalProblems} ${totalProblems === 1 ? "problem" : "problems"} — ${tooltipText}`
    : tooltipText;

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
            aria-label={accessibleName}
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
