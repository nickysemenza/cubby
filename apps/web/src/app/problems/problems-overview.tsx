import { useQuery } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { CheckCircle } from "lucide-react";
import { useMemo, useRef } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useTRPC } from "~/trpc/react";
import { PROBLEM_SECTIONS } from "./components/problem-sections";
import { RecipeUsageContext } from "./components/recipe-usage-context";

export function ProblemsOverview() {
  const api = useTRPC();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const {
    data: problems,
    isLoading,
    error,
  } = useQuery(api.problems.getAllProblems.queryOptions());

  // Every product id across the product-bearing sections, so we fetch recipe
  // usage once for the whole page rather than per card.
  const productIds = useMemo(
    () =>
      problems
        ? uniq(
            [
              ...problems.duplicateUniqueProducts,
              ...problems.orphanedProducts,
              ...problems.invalidUPCs,
              ...problems.productsWithoutMappings,
              ...problems.ingredientsWithPartialCoverage,
              ...problems.productsWithIslandedMappings,
              ...problems.productsWithNoImages,
              ...problems.productsWithWrongCategory,
              ...problems.productsWithBetterUpcData,
            ].map((p) => p.id),
          )
        : [],
    [problems],
  );
  const { data: recipeUsage } = useQuery(
    api.problems.recipeUsageByProduct.queryOptions({ productIds }),
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

  if (!problems) {
    return (
      <ErrorDisplay
        error="No problem data available"
        className="rounded-md bg-accent/20 p-4"
      />
    );
  }

  // Both the summary chips and the section list derive from PROBLEM_SECTIONS,
  // so each check is declared exactly once (see ./components/problem-sections).
  const categoryLinks = PROBLEM_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    count: section.count(problems),
  })).filter((cat) => cat.count > 0);

  const scrollToSection = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <RecipeUsageContext.Provider value={recipeUsage ?? {}}>
      <div className="space-y-6">
        {/* Summary header */}
        {problems.totalProblems > 0 ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>
                <Badge variant="destructive" className="text-base">
                  {problems.totalProblems}
                </Badge>
                {problems.totalProblems === 1 ? "Issue" : "Issues"} Found
              </CardTitle>
              <div className="flex flex-wrap gap-2 pt-2">
                {categoryLinks.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => scrollToSection(cat.id)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-sm transition-colors hover:bg-muted/80"
                  >
                    {cat.label}
                    <Badge variant="destructive" className="ml-0.5">
                      {cat.count}
                    </Badge>
                  </button>
                ))}
              </div>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                <CheckCircle className="h-5 w-5 text-secondary-foreground" />
                All Good!
              </CardTitle>
              <CardDescription>
                All data consistency checks passed. No issues found.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {/* All problem sections */}
        {PROBLEM_SECTIONS.map((section) => (
          <div
            key={section.id}
            ref={(el) => {
              sectionRefs.current[section.id] = el;
            }}
          >
            {section.node(problems)}
          </div>
        ))}
      </div>
    </RecipeUsageContext.Provider>
  );
}
