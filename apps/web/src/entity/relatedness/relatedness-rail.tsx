import type { EntityRecommendationGroup } from "@cubby/schemas/entity-recommendations";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useMutation, useMutationState, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { DetailAction } from "~/entity/entity-detail/detail-action-context";
import { recommendations } from "~/integrations/tanstack-query/generated/recommendations.gen";
import { search } from "~/integrations/tanstack-query/generated/search.gen";
import { Row, Stack } from "~/ui/layout";
import { Button, buttonVariants } from "~/ui/primitives/button";

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
      <DetailAction>
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
      </DetailAction>
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
        className={buttonVariants({ variant: "outline" })}
      >
        Review recommendations
      </Link>
      <Link
        to="/recommendations/workbench"
        search={{ kind: "tag-propagation", source: productId }}
        className={buttonVariants({ variant: "outline" })}
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
  const [visibleCount, setVisibleCount] = useState(12);
  useEffect(() => {
    setVisibleCount(12);
  }, [product.id]);
  const { poll, relatednessQuery, refresh, group, status, indexing } =
    useRelatednessActions(product.id, operations);
  const items = group?.proposals ?? EMPTY_RELATED_PRODUCTS;
  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );
  const relatedProductIds = useMemo(
    () => visibleItems.map((item) => item.target.id),
    [visibleItems],
  );

  return (
    <Stack gap="sm">
      <RelatednessIndexPrompt
        status={status}
        indexing={indexing}
        refreshing={refresh.isPending}
        onRefresh={() =>
          refresh.mutate({ entityKind: "product", entityId: product.id })
        }
      />

      {poll.timedOut && (
        <DetailAction>
          <StillIndexingNotice
            onCheckAgain={() => poll.checkAgain(relatednessQuery.refetch)}
          />
        </DetailAction>
      )}

      {status === "unavailable" && (
        <p className="text-xs text-muted-foreground">
          Similarity is unavailable until embeddings are configured.
        </p>
      )}

      <EntityDisplayImagesProvider
        refs={relatedProductIds.map((entityId) => ({
          entityKind: "product",
          entityId,
        }))}
        seeded={seededDisplayImages}
      >
        {visibleItems.map((item) => (
          <RelatedProductRowWithCanonicalImage
            key={item.target.id}
            item={item}
          />
        ))}
      </EntityDisplayImagesProvider>

      {items.length > visibleCount && (
        <Button
          variant="outline"
          className="min-h-11 w-fit"
          onClick={() => setVisibleCount((count) => count + 12)}
        >
          Show {Math.min(12, items.length - visibleCount)} more products
        </Button>
      )}
      {status === "ready" && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No related products yet.
        </p>
      )}

      {status === "ready" && (
        <DetailAction>
          <ReadyRelatednessLinks productId={product.id} />
        </DetailAction>
      )}
    </Stack>
  );
}

function RelatedProductRowWithCanonicalImage({
  item,
}: {
  item: ProductRecommendationGroup["proposals"][number];
}) {
  const displayImage = useEntityDisplayImage({
    entityKind: "product",
    entityId: item.target.id,
  });

  return (
    <RelatedProductRow
      product={item.target}
      displayImage={displayImage}
      evidence={item.evidence
        .map((evidence) =>
          evidence.detail
            ? `${evidence.signal}: ${evidence.detail}`
            : evidence.signal,
        )
        .join(" · ")}
      action={
        <span className="font-mono text-2xs text-slate">
          {item.score > 0 ? `${Math.round(item.score * 100)}% similar` : null}
        </span>
      }
    />
  );
}

function useRelatednessActions(
  productId: ProductShortcode,
  operations: RelatednessRailOperations,
) {
  const poll = useEmbeddingReadinessPoll(productId);
  const { refetchInterval, notifyStatus } = poll;

  const relatednessQuery = useQuery({
    ...operations.recommendations.queryOptions({
      entityKind: "product",
      entityId: productId,
    }),
    refetchInterval,
  });
  const refreshOptions = operations.requestEmbeddingRefresh.mutationOptions();
  const outcomes = useMutationState({
    filters: {
      mutationKey: refreshOptions.mutationKey,
      predicate: (mutation) => {
        const input = z
          .object({ entityId: z.string() })
          .safeParse(mutation.state.variables);
        return input.success && input.data.entityId === productId;
      },
    },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
    }),
  });
  const latest = outcomes.reduce<(typeof outcomes)[number] | undefined>(
    (last, current) =>
      !last || current.submittedAt >= last.submittedAt ? current : last,
    undefined,
  );
  const startPoll = poll.start;
  const observedMutation = useRef(0);
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
  useEffect(() => {
    if (
      latest?.status !== "success" ||
      latest.submittedAt <= observedMutation.current
    )
      return;
    observedMutation.current = latest.submittedAt;
    if (status !== "ready" && status !== "unavailable") startPoll();
  }, [latest?.status, latest?.submittedAt, status, startPoll]);
  // Terminal readiness updates the visible "Indexing…" state the instant this
  // render sees it, rather than waiting a render behind for the effect below
  // to flip the poll's own phase — that effect governs the interval/timeout,
  // not the display.
  const indexing =
    poll.isPolling && status !== "ready" && status !== "unavailable";

  useEffect(() => {
    notifyStatus(status);
  }, [status, notifyStatus, poll.isPolling]);

  return { poll, relatednessQuery, refresh, group, status, indexing };
}
export function ProductRelatednessActions({
  productId,
}: {
  productId: ProductShortcode;
}) {
  const { poll, relatednessQuery, refresh, status, indexing } =
    useRelatednessActions(productId, productionOperations);
  return (
    <>
      {status === "uncomputed" || status === "stale" ? (
        <Button
          variant="outline"
          disabled={refresh.isPending || indexing}
          onClick={() =>
            refresh.mutate({ entityKind: "product", entityId: productId })
          }
        >
          <SparkleIcon />
          {indexing ? "Indexing…" : "Index now"}
        </Button>
      ) : null}
      {poll.timedOut ? (
        <Button
          variant="outline"
          onClick={() => poll.checkAgain(relatednessQuery.refetch)}
          title="Still indexing — this can take a minute."
        >
          Check index again
        </Button>
      ) : null}
      {status === "ready" ? (
        <ReadyRelatednessLinks productId={productId} />
      ) : null}
    </>
  );
}
