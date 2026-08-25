import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateQueryRoots } from "~/lib/query-keys";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../products/product-image-summaries";

const EMPTY_RELATED_PRODUCTS: RelatednessOut["items"] = [];

/**
 * Product's compact relationship ledger. Tags remain compatibility evidence;
 * semantic neighbours add discovery without pretending an unavailable index is
 * an empty catalogue.
 */
export function RelatednessRail({
  product,
}: {
  product: { id: ProductShortcode; tags: string[] };
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const relatedness = useQuery(
    api.relatedness.product.queryOptions(product.id),
  );
  const refresh = useMutation(
    api.search.requestEmbeddingRefresh.mutationOptions(),
  );
  const batch = useQuery({
    ...api.backgroundJobs.getBatchSummary.queryOptions({
      batchId: refresh.data?.batchId ?? "00000000-0000-4000-8000-000000000000",
    }),
    enabled: refresh.data?.batchId != null,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "running"
        ? 1_000
        : false,
  });

  const status = relatedness.data?.status;
  const items = relatedness.data?.items ?? EMPTY_RELATED_PRODUCTS;
  const relatedProductIds = useMemo(
    () => items.map((item) => item.shortcode),
    [items],
  );
  const indexing =
    batch.data?.status === "queued" || batch.data?.status === "running";

  useEffect(() => {
    if (!refresh.data?.batchId || indexing || !batch.data) return;
    // The worker has reached a terminal state. Re-read the product's status
    // rather than leaving the rail on the request-time readiness snapshot.
    invalidateQueryRoots(queryClient, [
      api.relatedness.product.queryKey(product.id),
    ]);
  }, [
    api.relatedness.product,
    batch.data,
    indexing,
    product.id,
    queryClient,
    refresh.data?.batchId,
  ]);

  return (
    <Stack gap="sm">
      {(status === "uncomputed" || status === "stale") && (
        <Row
          align="center"
          justify="between"
          gap="sm"
          className="border-border border-b pb-2"
        >
          <span className="text-muted-foreground text-xs">
            {status === "stale"
              ? "Similarity index is stale."
              : "Similarity index has not been computed."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refresh.isPending || indexing}
            onClick={() =>
              refresh.mutate({ entityType: "product", entityId: product.id })
            }
          >
            <Sparkles className="size-3" />
            {indexing ? "Indexing…" : "Index now"}
          </Button>
        </Row>
      )}

      {status === "unavailable" && (
        <p className="text-muted-foreground text-xs">
          Similarity is unavailable until embeddings are configured.
        </p>
      )}

      <ProductImageSummariesProvider productIds={relatedProductIds}>
        {items.map((item) => (
          <RelatedProductRow key={item.shortcode} item={item} />
        ))}
      </ProductImageSummariesProvider>

      {status === "ready" && relatedness.data?.items.length === 0 && (
        <p className="text-muted-foreground text-xs">
          No related products yet.
        </p>
      )}

      {status === "ready" && (
        <Row gap="sm">
          <Link
            to="/recommendations/workbench"
            search={{ kind: "product-related", source: product.id }}
            className="text-xs underline underline-offset-2"
          >
            Review recommendations
          </Link>
          <Link
            to="/recommendations/workbench"
            search={{ kind: "tag-propagation", source: product.id }}
            className="text-xs underline underline-offset-2"
          >
            Review tag proposals
          </Link>
        </Row>
      )}
    </Stack>
  );
}

function RelatedProductRow({
  item,
}: {
  item: RelatednessOut["items"][number];
}) {
  const images = useHydratedProductImages(item.shortcode);

  return (
    <Row
      align="center"
      justify="between"
      gap="sm"
      className="border-border border-b pb-1 last:border-b-0"
    >
      <EntityInlineLink
        entity="product"
        data={{ id: item.shortcode, name: item.title }}
        displayImage={images[0] ?? null}
        truncate
      />
      <span className="shrink-0 font-mono text-2xs text-slate">
        {item.score > 0
          ? `${Math.round(item.score * 100)}% similar`
          : item.evidence.map((evidence) => evidence.signal).join(" · ")}
      </span>
    </Row>
  );
}
