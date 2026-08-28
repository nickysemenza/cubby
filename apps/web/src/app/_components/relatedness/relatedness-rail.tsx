import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { backgroundBatch } from "~/lib/background-batch.functions";
import { relatedness } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";

import {
  ProductImageSummariesProvider,
  type ProductImageMap,
  useHydratedProductImages,
} from "../products/product-image-summaries";

const EMPTY_RELATED_PRODUCTS: RelatednessOut["items"] = [];

/** The rail's only remote dependencies, grouped so browser tests can use the
 * same parsed operation descriptors with an in-memory transport. */
export interface RelatednessRailOperations {
  relatedness: typeof relatedness.product;
  requestEmbeddingRefresh: typeof search.requestEmbeddingRefresh;
  batchSummary: typeof backgroundBatch.summary;
}

const productionOperations: RelatednessRailOperations = {
  relatedness: relatedness.product,
  requestEmbeddingRefresh: search.requestEmbeddingRefresh,
  batchSummary: backgroundBatch.summary,
};

/**
 * Product's compact relationship ledger. Tags remain compatibility evidence;
 * semantic neighbours add discovery without pretending an unavailable index is
 * an empty catalogue.
 */
export function RelatednessRail({
  product,
  operations = productionOperations,
  imageSummaries,
}: {
  product: { id: ProductShortcode; tags: string[] };
  operations?: RelatednessRailOperations;
  /** An established product-summary projection avoids a duplicate query. */
  imageSummaries?: ProductImageMap;
}) {
  const queryClient = useQueryClient();
  const relatednessQuery = useQuery(
    operations.relatedness.queryOptions(product.id),
  );
  const refresh = useMutation(
    operations.requestEmbeddingRefresh.mutationOptions(),
  );
  const batch = useQuery({
    ...operations.batchSummary.queryOptions({
      batchId: refresh.data?.batchId ?? "00000000-0000-4000-8000-000000000000",
    }),
    enabled: refresh.data?.batchId != null,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "running"
        ? 1_000
        : false,
  });

  const status = relatednessQuery.data?.status;
  const items = relatednessQuery.data?.items ?? EMPTY_RELATED_PRODUCTS;
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
    void invalidateOperationTags(queryClient, [["relatedness", "product"]]);
  }, [batch.data, indexing, queryClient, refresh.data?.batchId]);

  return (
    <Stack gap="sm">
      {(status === "uncomputed" || status === "stale") && (
        <Row
          align="center"
          justify="between"
          gap="sm"
          className="border-b border-border pb-2"
        >
          <span className="text-xs text-muted-foreground">
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
        <p className="text-xs text-muted-foreground">
          Similarity is unavailable until embeddings are configured.
        </p>
      )}

      <ProductImageSummariesProvider
        productIds={relatedProductIds}
        summaries={imageSummaries}
      >
        {items.map((item) => (
          <RelatedProductRow key={item.shortcode} item={item} />
        ))}
      </ProductImageSummariesProvider>

      {status === "ready" && relatednessQuery.data?.items.length === 0 && (
        <p className="text-xs text-muted-foreground">
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
      className="border-b border-border pb-1 last:border-b-0"
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
