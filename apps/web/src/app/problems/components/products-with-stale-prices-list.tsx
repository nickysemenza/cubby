import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import type { ProductWithStalePrice } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function ProductsWithStalePricesList({
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
              <Spinner className="mr-2" />
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
