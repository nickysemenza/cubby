import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import {
  Calendar,
  CheckCircle,
  DollarSign,
  ImageOff,
  Loader2,
  Utensils,
  Zap,
} from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { EntityIcon } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";
import type {
  DuplicateUniqueProduct,
  EmptyLocation,
  InvalidInventoryAmount,
  InvalidUPC,
  InventoryWithStaleValuation,
  OrphanedProduct,
  ProductWithoutMappings,
  ProductWithoutUPCImage,
  ProductWithStalePrice,
  ProductWithWrongCategory,
} from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./components/problem-section";

// Inline problem list components
function DuplicateUniqueProductsList({
  products,
}: {
  products: DuplicateUniqueProduct[];
}) {
  return (
    <ProblemSection
      title="Duplicate Unique Products"
      description="Products marked as unique (expectedQuantity=1) but found in multiple locations. These should be consolidated or have their expectedQuantity updated."
      entity="product"
      items={products}
      emptyMessage="No duplicate unique products found. All products with expectedQuantity=1 are in single locations."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: product.locations.map((location) => (
          <Badge
            key={location.id}
            variant="outline"
            className="flex items-center gap-1"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {location.name}
          </Badge>
        )),
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}

function OrphanedProductsList({ products }: { products: OrphanedProduct[] }) {
  return (
    <ProblemSection
      title="Orphaned Products"
      description="Products with no inventory entries. These may be unused and can potentially be deleted."
      entity="product"
      items={products}
      emptyMessage="No orphaned products found. All products have inventory entries."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        details: [
          <div
            key="created"
            className="flex items-center gap-1 text-muted-foreground text-sm"
          >
            <Calendar className="h-3 w-3" />
            Created {formatDistanceToNow(product.createdAt)} ago
          </div>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}

function InvalidUPCsList({ products }: { products: InvalidUPC[] }) {
  return (
    <ProblemSection
      title="Invalid UPCs"
      description="Products with invalid UPC formats or duplicate UPC codes."
      icon={Zap}
      items={products}
      emptyMessage="No invalid UPC codes found. All UPCs are properly formatted and unique."
      groupBy={(items) => {
        const groups: { [key: string]: InvalidUPC[] } = {};
        items.forEach((item) => {
          const groupName =
            item.issue === "invalid_format"
              ? "Invalid Format"
              : "Duplicate UPCs";
          if (!groups[groupName]) {
            groups[groupName] = [];
          }
          groups[groupName]!.push(item);
        });
        return groups;
      }}
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <Badge key="issue" variant="destructive">
            {product.issue === "invalid_format"
              ? "Invalid UPC"
              : "Duplicate UPC"}
          </Badge>,
          <code key="upc" className="rounded bg-muted px-2 py-1 text-sm">
            {product.upc}
          </code>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
        editLabel: "Fix",
      })}
    />
  );
}

function ProductsWithoutMappingsList({
  products,
}: {
  products: ProductWithoutMappings[];
}) {
  return (
    <ProblemSection
      title="Products Without Pricing"
      description="Products missing unit mappings. Add pricing information to enable value calculations."
      icon={DollarSign}
      items={products}
      emptyMessage="All products have unit mappings for pricing information."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        details: [
          <div
            key="created"
            className="flex items-center gap-1 text-muted-foreground text-sm"
          >
            <Calendar className="h-3 w-3" />
            Created {formatDistanceToNow(product.createdAt)} ago
          </div>,
        ],
        badges: [
          <Badge key="no-mappings" variant="outline" className="w-fit">
            No unit mappings
          </Badge>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
        editLabel: "Add Pricing",
      })}
    />
  );
}

function InvalidInventoryAmountsList({
  entries,
}: {
  entries: InvalidInventoryAmount[];
}) {
  return (
    <ProblemSection
      title="Invalid Inventory Amounts"
      description="Inventory entries with zero or negative amounts that should be fixed or removed."
      entity="inventory"
      items={entries}
      emptyMessage="All inventory entries have valid positive amounts."
      groupBy={(items) => {
        const groups: { [key: string]: InvalidInventoryAmount[] } = {};
        items.forEach((item) => {
          const groupName =
            item.issue === "zero" ? "Zero Amounts" : "Negative Amounts";
          if (!groups[groupName]) {
            groups[groupName] = [];
          }
          groups[groupName]!.push(item);
        });
        return groups;
      }}
      renderItem={(entry) => ({
        title: entry.productName,
        details: [
          <div
            key="location"
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <Badge key="issue" variant="destructive">
            {entry.issue === "zero" ? "Zero Amount" : "Negative Amount"}
          </Badge>,
          <code key="amount" className="rounded bg-muted px-2 py-1 text-sm">
            {entry.amount.value} {entry.amount.unit}
          </code>,
        ],
        route: { to: "/inventory/$id" as const, params: { id: entry.id } },
        editLabel: "Fix",
      })}
    />
  );
}

function EmptyLocationsList({ locations }: { locations: EmptyLocation[] }) {
  return (
    <ProblemSection
      title="Empty Locations"
      description="Leaf locations with no inventory entries. Consider adding inventory or removing unused locations."
      entity="location"
      items={locations}
      emptyMessage="All leaf locations have inventory entries."
      renderItem={(location) => {
        const details = [
          <div
            key="created"
            className="flex items-center gap-1 text-muted-foreground text-sm"
          >
            <Calendar className="h-3 w-3" />
            Created {formatDistanceToNow(location.createdAt)} ago
          </div>,
        ];

        if (location.lastBulkInventory) {
          details.push(
            <div
              key="last-inventory"
              className="flex items-center gap-1 text-muted-foreground text-sm"
            >
              <Calendar className="h-3 w-3" />
              Last inventory {formatDistanceToNow(location.lastBulkInventory)}{" "}
              ago
            </div>,
          );
        }

        return {
          title: location.name,
          badges: [
            <Badge key="type" variant="outline" className="capitalize">
              {location.type}
            </Badge>,
          ],
          details,
          route: {
            to: "/locations/$id" as const,
            params: { id: location.id },
          },
          editLabel: "View",
          customActions: (
            <Link
              to="/inventory/bulk-edit"
              search={{ locationId: location.id }}
            >
              <Button size="sm">Add Inventory</Button>
            </Link>
          ),
        };
      }}
    />
  );
}

function ProductsWithoutUPCImagesList({
  products,
}: {
  products: ProductWithoutUPCImage[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.product.backfillUPCImages.mutationOptions({
      onSuccess: (result) => {
        if (result.imported > 0) {
          toast.success(
            `Imported ${result.imported} image${result.imported !== 1 ? "s" : ""}`,
          );
        } else if (result.found === 0) {
          toast.info("No products need UPC images");
        } else {
          toast.info(`No images found for ${result.skipped} product(s)`);
        }
        queryClient.invalidateQueries({
          queryKey: api.problems.getAllProblems.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: api.product.list.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return (
    <ProblemSection
      title="Missing UPC Images"
      description="Products with UPC codes that don't have images fetched from the product database."
      icon={ImageOff}
      items={products}
      emptyMessage="All products with UPC codes have images."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Fetching...
            </>
          ) : (
            "Fetch All Images"
          )}
        </Button>
      }
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <code key="upc" className="rounded bg-muted px-2 py-1 text-sm">
            {product.upc}
          </code>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}

function ProductsWithWrongCategoryList({
  products,
}: {
  products: ProductWithWrongCategory[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.product.backfillFoodCategories.mutationOptions({
      onSuccess: (result) => {
        if (result.updated > 0) {
          toast.success(
            `Updated ${result.updated} product${result.updated !== 1 ? "s" : ""} to food category`,
          );
        } else {
          toast.info("No products need category update");
        }
        queryClient.invalidateQueries({
          queryKey: api.problems.getAllProblems.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: api.product.list.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const indicatorLabel = (indicator: "ndb" | "ingredient") => {
    switch (indicator) {
      case "ndb":
        return "Has NDB";
      case "ingredient":
        return "Has Ingredient";
    }
  };

  return (
    <ProblemSection
      title="Wrong Category"
      description="Products with food indicators (UPC, NDB, or ingredient link) but category is not set to 'food'."
      icon={Utensils}
      items={products}
      emptyMessage="All products with food indicators have correct categories."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Fixing...
            </>
          ) : (
            "Fix All Categories"
          )}
        </Button>
      }
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <Badge key="category" variant="outline">
            {product.category ?? "No category"}
          </Badge>,
          <Badge key="indicator" variant="secondary">
            {indicatorLabel(product.indicator)}
          </Badge>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}

function ProductsWithStalePricesList({
  products,
}: {
  products: ProductWithStalePrice[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.product.backfillProductPrices.mutationOptions({
      onSuccess: (result) => {
        if (result.updated > 0) {
          toast.success(
            `Synced ${result.updated} product price${result.updated !== 1 ? "s" : ""}`,
          );
        } else {
          toast.info("No products need price sync");
        }
        queryClient.invalidateQueries({
          queryKey: api.problems.getAllProblems.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: api.product.list.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return (
    <ProblemSection
      title="Stale Product Prices"
      description="Products where the stored price doesn't match the computed price from unit mappings."
      icon={DollarSign}
      items={products}
      emptyMessage="All product prices are in sync with their unit mappings."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Syncing...
            </>
          ) : (
            "Sync All Prices"
          )}
        </Button>
      }
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <Badge
            key="status"
            variant={product.status === "missing" ? "destructive" : "secondary"}
          >
            {product.status === "missing" ? "Missing" : "Stale"}
          </Badge>,
          <span key="prices" className="text-muted-foreground text-sm">
            {product.storedPrice !== null
              ? formatCurrency(product.storedPrice)
              : "null"}{" "}
            →{" "}
            {product.computedPrice != null
              ? formatCurrency(product.computedPrice)
              : "null"}
          </span>,
        ],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}

function InventoryWithStaleValuationsList({
  entries,
}: {
  entries: InventoryWithStaleValuation[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.inventory.backfillInventoryValuations.mutationOptions({
      onSuccess: (result) => {
        if (result.updated > 0) {
          toast.success(
            `Synced ${result.updated} inventory valuation${result.updated !== 1 ? "s" : ""}`,
          );
        } else {
          toast.info("No inventory entries need valuation sync");
        }
        queryClient.invalidateQueries({
          queryKey: api.problems.getAllProblems.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: api.inventory.list.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return (
    <ProblemSection
      title="Stale Inventory Valuations"
      description="Inventory entries where the stored valuation doesn't match amount × product price."
      icon={DollarSign}
      items={entries}
      emptyMessage="All inventory valuations are in sync."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Syncing...
            </>
          ) : (
            "Sync All Valuations"
          )}
        </Button>
      }
      renderItem={(entry) => ({
        title: entry.productName,
        details: [
          <div
            key="location"
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <span key="valuations" className="text-muted-foreground text-sm">
            {entry.storedValuation !== null
              ? formatCurrency(entry.storedValuation)
              : "null"}{" "}
            →{" "}
            {entry.expectedValuation != null
              ? formatCurrency(entry.expectedValuation)
              : "null"}
          </span>,
        ],
        route: { to: "/inventory/$id" as const, params: { id: entry.id } },
      })}
    />
  );
}

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
      id: "stale-prices",
      label: "Stale Prices",
      count: problems.productsWithStalePrices.length,
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
      count: problems.productsWithoutUPCImages.length,
    },
    {
      id: "categories",
      label: "Categories",
      count: problems.productsWithWrongCategory.length,
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
          sectionRefs.current["stale-prices"] = el;
        }}
      >
        <ProductsWithStalePricesList
          products={problems.productsWithStalePrices}
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
        <ProductsWithoutUPCImagesList
          products={problems.productsWithoutUPCImages}
        />
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
    </div>
  );
}
