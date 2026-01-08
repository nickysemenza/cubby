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
    ...api.problems.getAllProblems.queryOptions(),
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

  const totalProblems = problems?.totalProblems ?? 0;
  const hasProblems = totalProblems > 0;

  // Build tooltip content
  const tooltipParts: string[] = [];
  if (problems) {
    if (problems.duplicateUniqueProducts.length > 0) {
      tooltipParts.push(
        `${problems.duplicateUniqueProducts.length} duplicate${problems.duplicateUniqueProducts.length > 1 ? "s" : ""}`,
      );
    }
    if (problems.orphanedProducts.length > 0) {
      tooltipParts.push(`${problems.orphanedProducts.length} orphaned`);
    }
    if (problems.invalidUPCs.length > 0) {
      tooltipParts.push(`${problems.invalidUPCs.length} invalid UPC`);
    }
    if (problems.productsWithoutMappings.length > 0) {
      tooltipParts.push(
        `${problems.productsWithoutMappings.length} without pricing`,
      );
    }
    if (problems.invalidInventoryAmounts.length > 0) {
      tooltipParts.push(
        `${problems.invalidInventoryAmounts.length} invalid amount`,
      );
    }
    if (problems.emptyLocations.length > 0) {
      tooltipParts.push(`${problems.emptyLocations.length} empty location`);
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
