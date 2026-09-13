import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RelatednessOut } from "@cubby/schemas/relatedness";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { relatedness } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";

import {
  ProductImageSummariesProvider,
  type ProductImageMap,
  useHydratedProductImages,
} from "../products/product-image-summaries";
import { useEmbeddingReadinessPoll } from "./use-embedding-readiness-poll";

const EMPTY_RELATED_PRODUCTS: RelatednessOut["items"] = [];

/** The rail's only remote dependencies, grouped so browser tests can use the
 * same parsed operation descriptors with an in-memory transport. */
export interface RelatednessRailOperations {
  relatedness: typeof relatedness.product;
  requestEmbeddingRefresh: typeof search.requestEmbeddingRefresh;
}

const productionOperations: RelatednessRailOperations = {
  relatedness: relatedness.product,
  requestEmbeddingRefresh: search.requestEmbeddingRefresh,
};

function RelatednessIndexPrompt({
  status,
  indexing,
  refreshing,
  onRefresh,
}: {
  status: RelatednessOut["status"] | undefined;
  indexing: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (status !== "uncomputed" && status !== "stale") return null;
  return (
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
        disabled={refreshing || indexing}
        onClick={onRefresh}
      >
        <Sparkles className="size-3" />
        {indexing ? "Indexing…" : "Index now"}
      </Button>
    </Row>
  );
}

function StillIndexingNotice({ onCheckAgain }: { onCheckAgain: () => void }) {
  return (
    <Row
      align="center"
      justify="between"
      gap="sm"
      className="border-b border-border pb-2"
    >
      <span className="text-xs text-muted-foreground">
        Still indexing — this can take a minute.
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onCheckAgain}>
        Check again
      </Button>
    </Row>
  );
}

function ReadyRelatednessLinks({ productId }: { productId: ProductShortcode }) {
  return (
    <Row gap="sm">
      <Link
        to="/recommendations/workbench"
        search={{ kind: "product-related", source: productId }}
        className="text-xs underline underline-offset-2"
      >
        Review recommendations
      </Link>
      <Link
        to="/recommendations/workbench"
        search={{ kind: "tag-propagation", source: productId }}
        className="text-xs underline underline-offset-2"
      >
        Review tag proposals
      </Link>
    </Row>
  );
}

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
  const poll = useEmbeddingReadinessPoll(product.id);
  const { refetchInterval, notifyStatus } = poll;

  const relatednessQuery = useQuery({
    ...operations.relatedness.queryOptions(product.id),
    refetchInterval,
  });
  const refresh = useMutation(
    operations.requestEmbeddingRefresh.mutationOptions({
      onSuccess: () => poll.start(),
    }),
  );

  const status = relatednessQuery.data?.status;
  // Terminal readiness updates the visible "Indexing…" state the instant this
  // render sees it, rather than waiting a render behind for the effect below
  // to flip the poll's own phase — that effect governs the interval/timeout,
  // not the display.
  const indexing =
    poll.isPolling && status !== "ready" && status !== "unavailable";

  useEffect(() => {
    notifyStatus(status);
  }, [status, notifyStatus]);

  const items = relatednessQuery.data?.items ?? EMPTY_RELATED_PRODUCTS;
  const relatedProductIds = useMemo(
    () => items.map((item) => item.shortcode),
    [items],
  );

  return (
    <Stack gap="sm">
      <RelatednessIndexPrompt
        status={status}
        indexing={indexing}
        refreshing={refresh.isPending}
        onRefresh={() =>
          refresh.mutate({ entityType: "product", entityId: product.id })
        }
      />

      {poll.timedOut && (
        <StillIndexingNotice
          onCheckAgain={() => poll.checkAgain(relatednessQuery.refetch)}
        />
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

      {status === "ready" && <ReadyRelatednessLinks productId={product.id} />}
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
