import {
  type InventoryShortcode,
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { RecommendationKind } from "@cubby/schemas/recommendations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import {
  type EntityDisplayImagesQueryOptions,
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { RelatedProductRow } from "~/app/_components/relatedness/related-product-row";
import { inventory } from "~/app/inventory/inventory.functions";
import { DuplicateProductMergeFix } from "~/app/problems/components/tier2-fixes";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityMedia } from "~/entities/entity-media.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { recommendations } from "~/lib/recommendations.functions";

const productUpdateMutationOptions = entityMutationOptionsFactory(
  "product",
  "update",
);

export interface RecommendationWorkbenchOperations {
  readonly placement: typeof recommendations.placement;
  readonly tagPropagation: typeof recommendations.tagPropagation;
  readonly product: typeof recommendations.product;
  readonly duplicateProduct: typeof recommendations.duplicateProduct;
  readonly dismissTagPropagation: typeof recommendations.dismissTagPropagation;
  readonly dismissProduct: typeof recommendations.dismissProduct;
  readonly dismissDuplicateProduct: typeof recommendations.dismissDuplicateProduct;
  readonly moveEntries: typeof inventory.moveEntries;
  readonly productUpdateMutationOptions: typeof productUpdateMutationOptions;
  readonly displayImages: EntityDisplayImagesQueryOptions;
}

export const productionRecommendationWorkbenchOperations: RecommendationWorkbenchOperations =
  {
    placement: recommendations.placement,
    tagPropagation: recommendations.tagPropagation,
    product: recommendations.product,
    duplicateProduct: recommendations.duplicateProduct,
    dismissTagPropagation: recommendations.dismissTagPropagation,
    dismissProduct: recommendations.dismissProduct,
    dismissDuplicateProduct: recommendations.dismissDuplicateProduct,
    moveEntries: inventory.moveEntries,
    productUpdateMutationOptions,
    displayImages: (input) => entityMedia.displayImages.queryOptions(input),
  };

function RetryAction({
  onRetry,
  label = "Retry",
}: {
  onRetry?: () => void;
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 md:h-7"
      onClick={() => onRetry?.()}
    >
      {label}
    </Button>
  );
}

function ReadinessMessage({
  kind,
  onRetry,
}: {
  kind: "recommendations" | "tag proposals";
  onRetry?: () => void;
}) {
  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        This product&apos;s similarity index is not ready yet, so current {kind}{" "}
        cannot be reviewed.
      </p>
      <RetryAction onRetry={onRetry} label="Refresh index status" />
    </Stack>
  );
}

/** A focused review surface: candidates are always re-resolved, never URL data. */
export function RecommendationWorkbench({
  sourceId,
  inventoryId,
  kind,
  operations = productionRecommendationWorkbenchOperations,
}: {
  sourceId?: ProductShortcode;
  inventoryId?: InventoryShortcode;
  kind: RecommendationKind;
  operations?: RecommendationWorkbenchOperations;
}) {
  if (kind === "placement") {
    return inventoryId ? (
      <PlacementRecommendation
        inventoryId={inventoryId}
        operations={operations}
      />
    ) : null;
  }
  if (!sourceId) return null;
  return kind === "duplicate-product" ? (
    <DuplicateProductRecommendation
      sourceId={sourceId}
      operations={operations}
    />
  ) : kind === "tag-propagation" ? (
    <TagPropagationRecommendation sourceId={sourceId} operations={operations} />
  ) : (
    <ProductRelatednessRecommendation
      sourceId={sourceId}
      operations={operations}
    />
  );
}

function PlacementRecommendation({
  inventoryId,
  operations,
}: {
  inventoryId: InventoryShortcode;
  operations: RecommendationWorkbenchOperations;
}) {
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    operations.placement.queryOptions({ inventoryId }),
  );
  const accept = useMutation(
    operations.moveEntries.mutationOptions({
      onSuccess: () => {
        // The move's own ripple covers `problems`; the placement suggestion
        // that offered it is this page's alone.
        void invalidateOperationTags(
          queryClient,
          ripple.recommendationPlacement,
        );
      },
    }),
  );
  if (recommendation.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading recommendation…</p>
    );
  }
  if (recommendation.isError) {
    return (
      <ErrorDisplay
        error={recommendation.error}
        title="placement recommendations"
        onRetry={() => void recommendation.refetch?.()}
      />
    );
  }
  if (!recommendation.data) {
    return (
      <Stack gap="sm">
        <p className="text-sm text-muted-foreground">
          No current placement recommendation is available for this stock row.
        </p>
        <RetryAction
          onRetry={() => void recommendation.refetch?.()}
          label="Refresh recommendation"
        />
      </Stack>
    );
  }
  const data = recommendation.data;
  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        {data.productName} is parked in {data.sourceLocation.name}; another live
        stock row for this exact product is in {data.destination.name}.
      </p>
      <Button
        type="button"
        disabled={accept.isPending}
        onClick={() =>
          accept.mutate({
            items: [
              {
                inventoryEntryId: data.inventoryId,
                targetLocationId: data.destination.id,
              },
            ],
          })
        }
      >
        Move to {data.destination.name}
      </Button>
    </Stack>
  );
}

function TagPropagationRecommendation({
  sourceId,
  operations,
}: {
  sourceId: ProductShortcode;
  operations: RecommendationWorkbenchOperations;
}) {
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    operations.tagPropagation.queryOptions({ sourceId }),
  );
  const accept = useMutation(
    operations.productUpdateMutationOptions({
      onSuccess: () => {
        void invalidateOperationTags(
          queryClient,
          ripple.recommendationTagPropagation,
        );
      },
    }),
  );
  const dismiss = useMutation(
    operations.dismissTagPropagation.mutationOptions({}),
  );

  if (recommendation.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading tag proposals…</p>
    );
  }
  if (recommendation.isError) {
    return (
      <ErrorDisplay
        error={recommendation.error}
        title="tag proposals"
        onRetry={() => void recommendation.refetch?.()}
      />
    );
  }
  if (!recommendation.data) {
    return (
      <Stack gap="sm">
        <p className="text-sm text-muted-foreground">
          No current tag proposal is available for this product.
        </p>
        <RetryAction
          onRetry={() => void recommendation.refetch?.()}
          label="Refresh proposals"
        />
      </Stack>
    );
  }
  if (recommendation.data.status !== "ready") {
    return (
      <ReadinessMessage
        kind="tag proposals"
        onRetry={() => void recommendation.refetch?.()}
      />
    );
  }
  const data = recommendation.data;
  if (data.proposals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No current tag proposals.</p>
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        Each tag has agreement from at least three current semantic neighbours.
        Accepting adds only that tag through the normal product update path.
      </p>
      {data.proposals.map((proposal) => (
        <Row
          key={proposal.tag}
          align="center"
          justify="between"
          gap="sm"
          className="border-b border-border pb-2"
        >
          <Stack gap="tight">
            <span className="text-sm">{proposal.tag}</span>
            <span className="text-xs text-muted-foreground">
              {proposal.supportingProductCount} related products agree
            </span>
          </Stack>
          <Row gap="xs">
            <Button
              type="button"
              size="sm"
              disabled={accept.isPending}
              onClick={() =>
                accept.mutate({
                  id: sourceId,
                  data: {
                    tags: [...data.currentTags, proposal.tag],
                  },
                })
              }
            >
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate({ sourceId, tag: proposal.tag })}
            >
              <X className="size-3" />
              Dismiss
            </Button>
          </Row>
        </Row>
      ))}
    </Stack>
  );
}

function ProductRelatednessRecommendation({
  sourceId,
  operations,
}: {
  sourceId: ProductShortcode;
  operations: RecommendationWorkbenchOperations;
}) {
  const relatedness = useQuery(operations.product.queryOptions({ sourceId }));
  const dismiss = useMutation(operations.dismissProduct.mutationOptions({}));
  const items = useMemo(
    () => relatedness.data?.items ?? [],
    [relatedness.data?.items],
  );
  const productRefs = useMemo(
    () =>
      items.map((item) => ({
        entityType: "product" as const,
        entityId: item.shortcode,
      })),
    [items],
  );

  if (relatedness.isLoading)
    return (
      <p className="text-sm text-muted-foreground">Loading recommendations…</p>
    );
  if (relatedness.isError)
    return (
      <ErrorDisplay
        error={relatedness.error}
        title="recommendations"
        onRetry={() => void relatedness.refetch?.()}
      />
    );
  if (relatedness.data?.status !== "ready") {
    return (
      <ReadinessMessage
        kind="recommendations"
        onRetry={() => void relatedness.refetch?.()}
      />
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        Review each relationship against the current catalogue. Dismissal hides
        this exact candidate for this product.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No current recommendations.
        </p>
      ) : (
        <EntityDisplayImagesProvider
          refs={productRefs}
          queryOptions={operations.displayImages}
        >
          {items.map((item) => (
            <WorkbenchRelatedProductRow
              key={item.shortcode}
              item={item}
              pending={dismiss.isPending}
              onDismiss={() =>
                dismiss.mutate({
                  sourceId,
                  targetId: parseShortcodeFor("product", item.shortcode),
                })
              }
            />
          ))}
        </EntityDisplayImagesProvider>
      )}
    </Stack>
  );
}

function WorkbenchRelatedProductRow({
  item,
  pending,
  onDismiss,
}: {
  item: Awaited<
    ReturnType<typeof recommendations.product.call>
  >["items"][number];
  pending: boolean;
  onDismiss: () => void;
}) {
  const displayImage = useEntityDisplayImage({
    entityType: "product",
    entityId: item.shortcode,
  });
  return (
    <RelatedProductRow
      product={{ id: item.shortcode, name: item.title }}
      displayImage={displayImage}
      evidence={item.evidence.map((evidence) => evidence.signal).join(" · ")}
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onDismiss}
        >
          <X className="size-3" />
          Dismiss
        </Button>
      }
    />
  );
}

function DuplicateProductRecommendation({
  sourceId,
  operations,
}: {
  sourceId: ProductShortcode;
  operations: RecommendationWorkbenchOperations;
}) {
  const [merged, setMerged] = useState(false);
  const recommendation = useQuery(
    operations.duplicateProduct.queryOptions({ sourceId }),
  );
  const dismiss = useMutation(
    operations.dismissDuplicateProduct.mutationOptions({}),
  );

  if (merged) {
    return <p className="text-sm text-positive">Products merged.</p>;
  }
  if (recommendation.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading recommendation…</p>
    );
  }
  if (recommendation.isError) {
    return (
      <ErrorDisplay
        error={recommendation.error}
        title="duplicate-product recommendations"
        onRetry={() => void recommendation.refetch?.()}
      />
    );
  }
  if (!recommendation.data) {
    return (
      <Stack gap="sm">
        <p className="text-sm text-muted-foreground">
          No current duplicate-product candidate is available for this product.
        </p>
        <RetryAction
          onRetry={() => void recommendation.refetch?.()}
          label="Refresh candidate"
        />
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        Review the live duplicate cluster, choose the keeper, then inspect the
        merge impact before accepting.
      </p>
      <Row gap="sm">
        <DuplicateProductMergeFix
          variant={recommendation.data}
          close={() => setMerged(true)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ sourceId })}
        >
          <X className="size-3" />
          Dismiss
        </Button>
      </Row>
    </Stack>
  );
}
