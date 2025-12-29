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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EntityIcon } from "~/entities/entities";
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
      iconColor={products.length > 0 ? "text-red-500" : "text-green-500"}
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
      iconColor={products.length > 0 ? "text-gray-500" : "text-green-500"}
      items={products}
      emptyMessage="No orphaned products found. All products have inventory entries."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        details: [
          <div
            key="created"
            className="flex items-center gap-1 text-gray-500 text-sm"
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
      iconColor={products.length > 0 ? "text-yellow-500" : "text-green-500"}
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
          <code key="upc" className="rounded bg-gray-100 px-2 py-1 text-sm">
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
      iconColor={products.length > 0 ? "text-red-500" : "text-green-500"}
      items={products}
      emptyMessage="All products have unit mappings for pricing information."
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        details: [
          <div
            key="created"
            className="flex items-center gap-1 text-gray-500 text-sm"
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
      entity="inventory-item"
      iconColor={entries.length > 0 ? "text-red-500" : "text-green-500"}
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
            className="flex items-center gap-2 text-gray-600 text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <Badge key="issue" variant="destructive">
            {entry.issue === "zero" ? "Zero Amount" : "Negative Amount"}
          </Badge>,
          <code key="amount" className="rounded bg-gray-100 px-2 py-1 text-sm">
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
      iconColor={locations.length > 0 ? "text-purple-500" : "text-green-500"}
      items={locations}
      emptyMessage="All leaf locations have inventory entries."
      renderItem={(location) => {
        const details = [
          <div
            key="created"
            className="flex items-center gap-1 text-gray-500 text-sm"
          >
            <Calendar className="h-3 w-3" />
            Created {formatDistanceToNow(location.createdAt)} ago
          </div>,
        ];

        if (location.lastBulkInventory) {
          details.push(
            <div
              key="last-inventory"
              className="flex items-center gap-1 text-gray-500 text-sm"
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
      iconColor={products.length > 0 ? "text-orange-500" : "text-green-500"}
      items={products}
      emptyMessage="All products with UPC codes have images."
      headerAction={
        products.length > 0 ? (
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
        ) : undefined
      }
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: [
          <code key="upc" className="rounded bg-gray-100 px-2 py-1 text-sm">
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
      iconColor={products.length > 0 ? "text-orange-500" : "text-green-500"}
      items={products}
      emptyMessage="All products with food indicators have correct categories."
      headerAction={
        products.length > 0 ? (
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
        ) : undefined
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
      iconColor={products.length > 0 ? "text-orange-500" : "text-green-500"}
      items={products}
      emptyMessage="All product prices are in sync with their unit mappings."
      headerAction={
        products.length > 0 ? (
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
        ) : undefined
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
              ? `$${product.storedPrice.toFixed(2)}`
              : "null"}{" "}
            → ${product.computedPrice?.toFixed(2) ?? "null"}
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
    api.inventoryItem.backfillInventoryValuations.mutationOptions({
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
          queryKey: api.inventoryItem.list.queryKey(),
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
      iconColor={entries.length > 0 ? "text-orange-500" : "text-green-500"}
      items={entries}
      emptyMessage="All inventory valuations are in sync."
      headerAction={
        entries.length > 0 ? (
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
        ) : undefined
      }
      renderItem={(entry) => ({
        title: entry.productName,
        details: [
          <div
            key="location"
            className="flex items-center gap-2 text-gray-600 text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <span key="valuations" className="text-muted-foreground text-sm">
            {entry.storedValuation !== null
              ? `$${entry.storedValuation.toFixed(2)}`
              : "null"}{" "}
            → ${entry.expectedValuation?.toFixed(2) ?? "null"}
          </span>,
        ],
        route: { to: "/inventory/$id" as const, params: { id: entry.id } },
      })}
    />
  );
}

export function ProblemsOverview() {
  const api = useTRPC();

  const {
    data: problems,
    isLoading,
    error,
  } = useQuery(api.problems.getAllProblems.queryOptions());

  if (isLoading) {
    return <SimpleLoading text="Analyzing data consistency..." />;
  }

  if (error) {
    return <ErrorDisplay error={error} className="rounded-md bg-red-50 p-4" />;
  }

  if (!problems) {
    return (
      <ErrorDisplay
        error="No problem data available"
        className="rounded-md bg-yellow-50 p-4"
      />
    );
  }

  const hasProblems = problems.totalProblems > 0;

  return (
    <div className="space-y-6">
      {hasProblems ? (
        <Tabs defaultValue="duplicates" className="space-y-4">
          <TabsList className="flex w-full overflow-x-auto lg:grid lg:grid-cols-10">
            <TabsTrigger value="duplicates" className="flex items-center gap-1">
              Duplicates
              {problems.duplicateUniqueProducts.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.duplicateUniqueProducts.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="orphaned" className="flex items-center gap-1">
              Orphaned
              {problems.orphanedProducts.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.orphanedProducts.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="upcs" className="flex items-center gap-1">
              UPCs
              {problems.invalidUPCs.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.invalidUPCs.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="pricing" className="flex items-center gap-1">
              Pricing
              {problems.productsWithoutMappings.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.productsWithoutMappings.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="stale-prices"
              className="flex items-center gap-1"
            >
              Prices
              {problems.productsWithStalePrices.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.productsWithStalePrices.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="stale-valuations"
              className="flex items-center gap-1"
            >
              Valuations
              {problems.inventoryWithStaleValuations.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.inventoryWithStaleValuations.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="amounts" className="flex items-center gap-1">
              Amounts
              {problems.invalidInventoryAmounts.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.invalidInventoryAmounts.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="locations" className="flex items-center gap-1">
              Locations
              {problems.emptyLocations.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.emptyLocations.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="images" className="flex items-center gap-1">
              Images
              {problems.productsWithoutUPCImages.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.productsWithoutUPCImages.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="categories" className="flex items-center gap-1">
              Categories
              {problems.productsWithWrongCategory.length > 0 && (
                <Badge variant="destructive" className="ml-1">
                  {problems.productsWithWrongCategory.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="duplicates">
            <DuplicateUniqueProductsList
              products={problems.duplicateUniqueProducts}
            />
          </TabsContent>

          <TabsContent value="orphaned">
            <OrphanedProductsList products={problems.orphanedProducts} />
          </TabsContent>

          <TabsContent value="upcs">
            <InvalidUPCsList products={problems.invalidUPCs} />
          </TabsContent>

          <TabsContent value="pricing">
            <ProductsWithoutMappingsList
              products={problems.productsWithoutMappings}
            />
          </TabsContent>

          <TabsContent value="stale-prices">
            <ProductsWithStalePricesList
              products={problems.productsWithStalePrices}
            />
          </TabsContent>

          <TabsContent value="stale-valuations">
            <InventoryWithStaleValuationsList
              entries={problems.inventoryWithStaleValuations}
            />
          </TabsContent>

          <TabsContent value="amounts">
            <InvalidInventoryAmountsList
              entries={problems.invalidInventoryAmounts}
            />
          </TabsContent>

          <TabsContent value="locations">
            <EmptyLocationsList locations={problems.emptyLocations} />
          </TabsContent>

          <TabsContent value="images">
            <ProductsWithoutUPCImagesList
              products={problems.productsWithoutUPCImages}
            />
          </TabsContent>

          <TabsContent value="categories">
            <ProductsWithWrongCategoryList
              products={problems.productsWithWrongCategory}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              All Good!
            </CardTitle>
            <CardDescription>
              All data consistency checks passed. No issues found.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
