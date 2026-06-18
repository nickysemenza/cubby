import type { ProblemsCount } from "@cubby/schemas/problems";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";

const pl = (n: number, sing: string, plur = `${sing}s`) =>
  `${n} ${n === 1 ? sing : plur}`;

// One tooltip phrase per `byType` key, in Problems-page section order. A Record
// (not a list) so adding a category to the count schema is a *compile error*
// here until its phrase is added — the breakdown always sums to `total`. Object
// insertion order drives the tooltip order.
const PROBLEM_LABELS: Record<
  keyof ProblemsCount["byType"],
  (n: number) => string
> = {
  duplicateUniqueProducts: (n) => pl(n, "duplicate"),
  orphanedProducts: (n) => `${n} orphaned`,
  invalidUPCs: (n) => pl(n, "invalid UPC"),
  productsWithoutMappings: (n) => `${n} without pricing`,
  ingredientsWithPartialCoverage: (n) => `${n} partial coverage`,
  productsWithIslandedMappings: (n) => pl(n, "islanded mapping"),
  inventoryWithStaleValuations: (n) => pl(n, "stale valuation"),
  invalidInventoryAmounts: (n) => pl(n, "invalid amount"),
  emptyLocations: (n) => pl(n, "empty location"),
  productsWithNoImages: (n) => pl(n, "missing image"),
  productsWithWrongCategory: (n) => pl(n, "wrong category", "wrong categories"),
  locationsWithoutAiDescription: (n) => pl(n, "missing AI description"),
  staleIngredientParses: (n) => pl(n, "stale parse"),
  staleRecipeTotals: (n) => pl(n, "stale total"),
  productsWithBetterUpcData: (n) => pl(n, "UPC update"),
};

export const ProblemsBadge = () => {
  const api = useTRPC();

  const { data: problems, isLoading } = useQuery({
    ...api.problems.getProblemsCount.queryOptions(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Loading state
  if (isLoading) {
    return (
      <Button variant="ghost" size="sm" disabled className="h-8 px-2">
        <Spinner />
      </Button>
    );
  }

  const totalProblems = problems?.total ?? 0;
  const hasProblems = totalProblems > 0;

  // One phrase per category, in Problems-page section order, so the breakdown
  // sums to `total` (every byType key is listed — no silent omissions).
  const tooltipParts = problems
    ? Object.entries(PROBLEM_LABELS).flatMap(([key, phrase]) => {
        const n = problems.byType[key as keyof ProblemsCount["byType"]];
        return n > 0 ? [phrase(n)] : [];
      })
    : [];

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
            <AlertTriangle className="h-4 w-4" />
            {totalProblems}
          </span>
        ) : (
          <Check className="h-4 w-4" />
        )}
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  );
};
