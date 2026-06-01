import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import type { ProductWithNoImages } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function ProductsWithNoImagesList({
  products,
}: {
  products: ProductWithNoImages[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const productsWithUPC = products.filter((p) => p.upc != null);

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
      title="Missing Images"
      description="Products that don't have any images."
      icon={ImageOff}
      items={products}
      emptyMessage="All products have images."
      headerAction={
        productsWithUPC.length > 0 ? (
          <Button
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
          >
            {backfillMutation.isPending ? (
              <>
                <Spinner className="mr-2" />
                Fetching...
              </>
            ) : (
              `Fetch UPC Images (${productsWithUPC.length})`
            )}
          </Button>
        ) : undefined
      }
      renderItem={(product) => ({
        title: product.name,
        subtitle: `by ${product.manufacturer}`,
        badges: product.upc
          ? [
              <code key="upc" className="rounded bg-muted px-2 py-1 text-sm">
                {product.upc}
              </code>,
            ]
          : [],
        route: { to: "/products/$id" as const, params: { id: product.id } },
      })}
    />
  );
}
