import { useQuery } from "@tanstack/react-query";
import { CheckCircle } from "lucide-react";
import { useRef } from "react";
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
import { DuplicateUniqueProductsList } from "./components/duplicate-unique-products-list";
import { EmptyLocationsList } from "./components/empty-locations-list";
import { InvalidInventoryAmountsList } from "./components/invalid-inventory-amounts-list";
import { InvalidUPCsList } from "./components/invalid-upcs-list";
import { InventoryWithStaleValuationsList } from "./components/inventory-with-stale-valuations-list";
import { LocationsWithoutAiDescriptionList } from "./components/locations-without-ai-description-list";
import { OrphanedProductsList } from "./components/orphaned-products-list";
import { ProductsWithIslandedMappingsList } from "./components/products-with-islanded-mappings-list";
import { ProductsWithNoImagesList } from "./components/products-with-no-images-list";
import { ProductsWithWrongCategoryList } from "./components/products-with-wrong-category-list";
import { ProductsWithoutMappingsList } from "./components/products-without-mappings-list";
import { StaleIngredientParsesList } from "./components/stale-ingredient-parses-list";

export function ProblemsOverview() {
  const api = useTRPC();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const {
    data: problems,
    isLoading,
    error,
  } = useQuery(api.problems.getAllProblems.queryOptions());

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

  // Categories with issues for the summary links
  const categoryLinks = [
    {
      id: "duplicates",
      label: "Duplicates",
      count: problems.duplicateUniqueProducts.length,
    },
    {
      id: "orphaned",
      label: "Orphaned",
      count: problems.orphanedProducts.length,
    },
    { id: "upcs", label: "UPCs", count: problems.invalidUPCs.length },
    {
      id: "pricing",
      label: "Pricing",
      count: problems.productsWithoutMappings.length,
    },
    {
      id: "islands",
      label: "Disconnected Mappings",
      count: problems.productsWithIslandedMappings.length,
    },
    {
      id: "stale-valuations",
      label: "Stale Valuations",
      count: problems.inventoryWithStaleValuations.length,
    },
    {
      id: "amounts",
      label: "Amounts",
      count: problems.invalidInventoryAmounts.length,
    },
    {
      id: "locations",
      label: "Locations",
      count: problems.emptyLocations.length,
    },
    {
      id: "images",
      label: "Images",
      count: problems.productsWithNoImages.length,
    },
    {
      id: "categories",
      label: "Categories",
      count: problems.productsWithWrongCategory.length,
    },
    {
      id: "ai-descriptions",
      label: "AI Descriptions",
      count: (problems.locationsWithoutAiDescription ?? []).length,
    },
    {
      id: "stale-parses",
      label: "Stale Parses",
      count: (problems.staleIngredientParses ?? []).length,
    },
  ].filter((cat) => cat.count > 0);

  const scrollToSection = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="space-y-6">
      {/* Summary header */}
      {problems.totalProblems > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
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
            <CardTitle className="flex items-center gap-2">
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
      <div
        ref={(el) => {
          sectionRefs.current.duplicates = el;
        }}
      >
        <DuplicateUniqueProductsList
          products={problems.duplicateUniqueProducts}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.orphaned = el;
        }}
      >
        <OrphanedProductsList products={problems.orphanedProducts} />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.upcs = el;
        }}
      >
        <InvalidUPCsList products={problems.invalidUPCs} />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.pricing = el;
        }}
      >
        <ProductsWithoutMappingsList
          products={problems.productsWithoutMappings}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current["stale-valuations"] = el;
        }}
      >
        <InventoryWithStaleValuationsList
          entries={problems.inventoryWithStaleValuations}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.amounts = el;
        }}
      >
        <InvalidInventoryAmountsList
          entries={problems.invalidInventoryAmounts}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.locations = el;
        }}
      >
        <EmptyLocationsList locations={problems.emptyLocations} />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.images = el;
        }}
      >
        <ProductsWithNoImagesList products={problems.productsWithNoImages} />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.categories = el;
        }}
      >
        <ProductsWithWrongCategoryList
          products={problems.productsWithWrongCategory}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current.islands = el;
        }}
      >
        <ProductsWithIslandedMappingsList
          products={problems.productsWithIslandedMappings}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current["ai-descriptions"] = el;
        }}
      >
        <LocationsWithoutAiDescriptionList
          locations={problems.locationsWithoutAiDescription ?? []}
        />
      </div>
      <div
        ref={(el) => {
          sectionRefs.current["stale-parses"] = el;
        }}
      >
        <StaleIngredientParsesList
          items={problems.staleIngredientParses ?? []}
        />
      </div>
    </div>
  );
}
