import {
  type InventoryShortcode,
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { RecommendationKind } from "@cubby/schemas/recommendations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { inventory } from "~/app/inventory/inventory.functions";
import { DuplicateProductMergeFix } from "~/app/problems/components/tier2-fixes";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { recommendations } from "~/lib/recommendations.functions";

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
    recommendations.placement.queryOptions({ inventoryId }),
  );
  const accept = useMutation(
    inventory.moveEntries.mutationOptions({
      onSuccess: () => {
        // The move's own ripple covers `problems`; the placement suggestion
        // that offered it is this page's alone.
        void invalidateOperationTags(queryClient, [
          ["recommendations", "placement"],
        ]);
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
      <Stack gap="sm">
        <p className="text-sm text-destructive">
          Placement recommendations could not be loaded.
        </p>
        <RetryAction onRetry={() => void recommendation.refetch?.()} />
      </Stack>
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
}: {
  sourceId: ProductShortcode;
}) {
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    recommendations.tagPropagation.queryOptions({ sourceId }),
  );
  const accept = useMutation(
    entityMutationOptionsFactory(
      "product",
      "update",
    )({
      onSuccess: () => {
        void invalidateOperationTags(queryClient, [
          ["recommendations", "tagPropagation"],
          ["relatedness", "product"],
        ]);
      },
    }),
  );
  const dismiss = useMutation(
    recommendations.dismissTagPropagation.mutationOptions({}),
  );

  if (recommendation.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading tag proposals…</p>
    );
  }
  if (recommendation.isError) {
    return (
      <Stack gap="sm">
        <p className="text-sm text-destructive">
          Tag proposals could not be loaded.
        </p>
        <RetryAction onRetry={() => void recommendation.refetch?.()} />
      </Stack>
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
}: {
  sourceId: ProductShortcode;
}) {
  const relatedness = useQuery(
    recommendations.product.queryOptions({ sourceId }),
  );
  const dismiss = useMutation(
    recommendations.dismissProduct.mutationOptions({}),
  );
  const items = relatedness.data?.items ?? [];

  if (relatedness.isLoading)
    return (
      <p className="text-sm text-muted-foreground">Loading recommendations…</p>
    );
  if (relatedness.isError)
    return (
      <Stack gap="sm">
        <p className="text-sm text-destructive">
          Recommendations could not be loaded.
        </p>
        <RetryAction onRetry={() => void relatedness.refetch?.()} />
      </Stack>
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
        items.map((item) => (
          <Row
            key={item.shortcode}
            align="center"
            justify="between"
            gap="sm"
            className="border-b border-border pb-2"
          >
            <Stack gap="tight" className="min-w-0">
              <EntityInlineLink
                entity="product"
                data={{ id: item.shortcode, name: item.title }}
                displayImage={null}
                truncate
              />
              <span className="text-xs text-muted-foreground">
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
                  targetId: parseShortcodeFor("product", item.shortcode),
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
  const [merged, setMerged] = useState(false);
  const recommendation = useQuery(
    recommendations.duplicateProduct.queryOptions({ sourceId }),
  );
  const dismiss = useMutation(
    recommendations.dismissDuplicateProduct.mutationOptions({}),
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
      <Stack gap="sm">
        <p className="text-sm text-destructive">
          Duplicate-product recommendations could not be loaded.
        </p>
        <RetryAction onRetry={() => void recommendation.refetch?.()} />
      </Stack>
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
