import type {
  InventoryShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { RecommendationKind } from "@cubby/schemas/recommendations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { moveInventoryEntriesMutationOptions } from "~/app/inventory/inventory.functions";
import { DuplicateProductMergeFix } from "~/app/problems/components/tier2-fixes";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { problemsRootKey } from "~/lib/problems.functions";
import { invalidateQueryRoots } from "~/lib/query-keys";
import {
  dismissDuplicateProductRecommendationMutationOptions,
  dismissProductRecommendationMutationOptions,
  dismissTagPropagationMutationOptions,
  duplicateProductRecommendationQueryOptions,
  placementRecommendationQueryOptions,
  productRecommendationQueryOptions,
  recommendationRootKey,
  relatednessProductRootKey,
  tagPropagationRecommendationQueryOptions,
} from "~/lib/recommendations.functions";

/** A focused review surface: candidates are always re-resolved, never URL data. */
export function RecommendationWorkbench({
  sourceId,
  inventoryId,
  kind,
}: {
  sourceId?: ProductShortcode;
  inventoryId?: InventoryShortcode;
  kind: RecommendationKind;
}) {
  if (kind === "placement") {
    return inventoryId ? (
      <PlacementRecommendation inventoryId={inventoryId} />
    ) : null;
  }
  if (!sourceId) return null;
  return kind === "duplicate-product" ? (
    <DuplicateProductRecommendation sourceId={sourceId} />
  ) : kind === "tag-propagation" ? (
    <TagPropagationRecommendation sourceId={sourceId} />
  ) : (
    <ProductRelatednessRecommendation sourceId={sourceId} />
  );
}

function PlacementRecommendation({
  inventoryId,
}: {
  inventoryId: InventoryShortcode;
}) {
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    placementRecommendationQueryOptions({ inventoryId }),
  );
  const accept = useMutation(
    moveInventoryEntriesMutationOptions({
      onSuccess: () => {
        invalidateQueryRoots(queryClient, [
          recommendationRootKey("placement"),
          problemsRootKey("getFast"),
        ]);
      },
    }),
  );
  if (recommendation.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading recommendation…</p>
    );
  }
  if (recommendation.isError || !recommendation.data) {
    return (
      <p className="text-muted-foreground text-sm">
        This placement recommendation is no longer current.
      </p>
    );
  }
  const data = recommendation.data;
  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-sm">
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
}: {
  sourceId: ProductShortcode;
}) {
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    tagPropagationRecommendationQueryOptions({ sourceId }),
  );
  const accept = useMutation(
    entityMutationOptionsFactory(
      "product",
      "update",
    )({
      onSuccess: () => {
        invalidateQueryRoots(queryClient, [
          recommendationRootKey("tagPropagation"),
          relatednessProductRootKey(),
        ]);
      },
    }),
  );
  const dismiss = useMutation(
    dismissTagPropagationMutationOptions({
      onSuccess: () => {
        invalidateQueryRoots(queryClient, [
          recommendationRootKey("tagPropagation"),
        ]);
      },
    }),
  );

  if (recommendation.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading tag proposals…</p>
    );
  }
  if (
    !recommendation.data ||
    recommendation.isError ||
    recommendation.data.status !== "ready"
  ) {
    return (
      <p className="text-muted-foreground text-sm">
        This product needs a current similarity index before tag proposals can
        be reviewed.
      </p>
    );
  }
  const data = recommendation.data;
  if (data.proposals.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No current tag proposals.</p>
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-sm">
        Each tag has agreement from at least three current semantic neighbours.
        Accepting adds only that tag through the normal product update path.
      </p>
      {data.proposals.map((proposal) => (
        <Row
          key={proposal.tag}
          align="center"
          justify="between"
          gap="sm"
          className="border-border border-b pb-2"
        >
          <Stack gap="tight">
            <span className="text-sm">{proposal.tag}</span>
            <span className="text-muted-foreground text-xs">
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
}: {
  sourceId: ProductShortcode;
}) {
  const queryClient = useQueryClient();
  const relatedness = useQuery(productRecommendationQueryOptions({ sourceId }));
  const dismiss = useMutation(
    dismissProductRecommendationMutationOptions({
      onSuccess: () => {
        invalidateQueryRoots(queryClient, [recommendationRootKey("product")]);
      },
    }),
  );
  const items = relatedness.data?.items ?? [];

  if (relatedness.isLoading)
    return (
      <p className="text-muted-foreground text-sm">Loading recommendations…</p>
    );
  if (relatedness.isError)
    return (
      <p className="text-destructive text-sm">
        Recommendations could not be refreshed.
      </p>
    );
  if (relatedness.data?.status !== "ready") {
    return (
      <p className="text-muted-foreground text-sm">
        This product needs a current similarity index before recommendations can
        be reviewed.
      </p>
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-sm">
        Review each relationship against the current catalogue. Dismissal hides
        this exact candidate for this product.
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No current recommendations.
        </p>
      ) : (
        items.map((item) => (
          <Row
            key={item.shortcode}
            align="center"
            justify="between"
            gap="sm"
            className="border-border border-b pb-2"
          >
            <Stack gap="tight" className="min-w-0">
              <EntityInlineLink
                entity="product"
                data={{ id: item.shortcode, name: item.title }}
                displayImage={null}
                truncate
              />
              <span className="text-muted-foreground text-xs">
                {item.evidence.map((evidence) => evidence.signal).join(" · ")}
              </span>
            </Stack>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={dismiss.isPending}
              onClick={() =>
                dismiss.mutate({
                  sourceId,
                  targetId: item.shortcode as ProductShortcode,
                })
              }
            >
              <X className="size-3" />
              Dismiss
            </Button>
          </Row>
        ))
      )}
    </Stack>
  );
}

function DuplicateProductRecommendation({
  sourceId,
}: {
  sourceId: ProductShortcode;
}) {
  const queryClient = useQueryClient();
  const [merged, setMerged] = useState(false);
  const recommendation = useQuery(
    duplicateProductRecommendationQueryOptions({ sourceId }),
  );
  const dismiss = useMutation(
    dismissDuplicateProductRecommendationMutationOptions({
      onSuccess: () => {
        invalidateQueryRoots(queryClient, [
          recommendationRootKey("duplicateProduct"),
        ]);
      },
    }),
  );

  if (merged) {
    return <p className="text-positive text-sm">Products merged.</p>;
  }
  if (recommendation.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">Loading recommendation…</p>
    );
  }
  if (recommendation.isError || !recommendation.data) {
    return (
      <p className="text-muted-foreground text-sm">
        This duplicate-product recommendation is no longer current.
      </p>
    );
  }

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-sm">
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
