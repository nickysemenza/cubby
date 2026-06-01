import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Utensils } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import type { ProductWithWrongCategory } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function ProductsWithWrongCategoryList({
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
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [api.problems.getAllProblems.queryKey()],
        });
        queryClient.invalidateQueries({
          queryKey: [api.product.list.queryKey()],
        });
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
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
              <Spinner className="mr-2" />
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
