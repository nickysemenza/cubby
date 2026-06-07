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

  // Build tooltip content
  const tooltipParts: string[] = [];
  if (problems) {
    if (problems.byType.duplicateUniqueProducts > 0) {
      tooltipParts.push(
        `${problems.byType.duplicateUniqueProducts} duplicate${problems.byType.duplicateUniqueProducts > 1 ? "s" : ""}`,
      );
    }
    if (problems.byType.orphanedProducts > 0) {
      tooltipParts.push(`${problems.byType.orphanedProducts} orphaned`);
    }
    if (problems.byType.invalidUPCs > 0) {
      tooltipParts.push(`${problems.byType.invalidUPCs} invalid UPC`);
    }
    if (problems.byType.productsWithoutMappings > 0) {
      tooltipParts.push(
        `${problems.byType.productsWithoutMappings} without pricing`,
      );
    }
    if (problems.byType.invalidInventoryAmounts > 0) {
      tooltipParts.push(
        `${problems.byType.invalidInventoryAmounts} invalid amount`,
      );
    }
    if (problems.byType.emptyLocations > 0) {
      tooltipParts.push(`${problems.byType.emptyLocations} empty location`);
    }
    if (problems.byType.staleIngredientParses > 0) {
      tooltipParts.push(
        `${problems.byType.staleIngredientParses} stale parse${problems.byType.staleIngredientParses > 1 ? "s" : ""}`,
      );
    }
  }

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
