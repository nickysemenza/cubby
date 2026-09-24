import type { EntityRecommendationGroup } from "@cubby/schemas/entity-recommendations";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { recommendations } from "~/lib/recommendations.functions";
import { search } from "~/lib/search.functions";

import {
  type EntityDisplayImageMap,
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "../entity-media/entity-display-images";
import { RelatedProductRow } from "./related-product-row";
import { useEmbeddingReadinessPoll } from "./use-embedding-readiness-poll";

type ProductRecommendationGroup = Extract<
  EntityRecommendationGroup,
  { kind: "product-related" }
>;
const EMPTY_RELATED_PRODUCTS: ProductRecommendationGroup["proposals"] = [];

/** The rail's only remote dependencies, grouped so browser tests can use the
 * same parsed operation descriptors with an in-memory transport. */
export interface RelatednessRailOperations {
  recommendations: typeof recommendations.forEntity;
  requestEmbeddingRefresh: typeof search.requestEmbeddingRefresh;
}

const productionOperations: RelatednessRailOperations = {
  recommendations: recommendations.forEntity,
  requestEmbeddingRefresh: search.requestEmbeddingRefresh,
};

function RelatednessIndexPrompt({
  status,
  indexing,
  refreshing,
  onRefresh,
}: {
  status: ProductRecommendationGroup["status"] | undefined;
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
        <SparkleIcon className="size-3" />
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
  seededDisplayImages,
}: {
  product: { id: ProductShortcode; tags: string[] };
  operations?: RelatednessRailOperations;
  /** Canonical results already resolved by a parent avoid duplicate work. */
  seededDisplayImages?: EntityDisplayImageMap;
}) {
  const poll = useEmbeddingReadinessPoll(product.id);
  const { refetchInterval, notifyStatus } = poll;

  const relatednessQuery = useQuery({
    ...operations.recommendations.queryOptions({
      entityType: "product",
      entityId: product.id,
    }),
    refetchInterval,
  });
  const refresh = useMutation(
    operations.requestEmbeddingRefresh.mutationOptions({
      onSuccess: () => poll.start(),
    }),
  );

  const group = relatednessQuery.data?.groups.find(
    (candidate): candidate is ProductRecommendationGroup =>
      candidate.kind === "product-related",
  );
  const status = group?.status;
  // Terminal readiness updates the visible "Indexing…" state the instant this
  // render sees it, rather than waiting a render behind for the effect below
  // to flip the poll's own phase — that effect governs the interval/timeout,
  // not the display.
  const indexing =
    poll.isPolling && status !== "ready" && status !== "unavailable";

  useEffect(() => {
    notifyStatus(status);
  }, [status, notifyStatus]);

  const items = group?.proposals ?? EMPTY_RELATED_PRODUCTS;
  const relatedProductIds = useMemo(
    () => items.map((item) => item.target.id),
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

      <EntityDisplayImagesProvider
        refs={relatedProductIds.map((entityId) => ({
          entityType: "product",
          entityId,
        }))}
        seeded={seededDisplayImages}
      >
        {items.map((item) => (
          <RelatedProductRowWithCanonicalImage
            key={item.target.id}
            item={item}
          />
        ))}
      </EntityDisplayImagesProvider>

      {status === "ready" && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No related products yet.
        </p>
      )}

      {status === "ready" && <ReadyRelatednessLinks productId={product.id} />}
    </Stack>
  );
}

function RelatedProductRowWithCanonicalImage({
  item,
}: {
  item: ProductRecommendationGroup["proposals"][number];
}) {
  const displayImage = useEntityDisplayImage({
    entityType: "product",
    entityId: item.target.id,
  });

  return (
    <RelatedProductRow
      product={item.target}
      displayImage={displayImage}
      action={
        <span className="font-mono text-2xs text-slate">
          {item.score > 0
            ? `${Math.round(item.score * 100)}% similar`
            : item.evidence.map((evidence) => evidence.signal).join(" · ")}
        </span>
      }
    />
  );
}
