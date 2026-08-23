import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { RecommendationKind } from "@cubby/schemas/recommendations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { DuplicateProductMergeFix } from "~/app/problems/components/tier2-fixes";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries } from "~/lib/query-keys";

/** A focused review surface: candidates are always re-resolved, never URL data. */
export function RecommendationWorkbench({
  sourceId,
  kind,
}: {
  sourceId: ProductShortcode;
  kind: RecommendationKind;
}) {
  return kind === "duplicate-product" ? (
    <DuplicateProductRecommendation sourceId={sourceId} />
  ) : kind === "tag-propagation" ? (
    <TagPropagationRecommendation sourceId={sourceId} />
  ) : (
    <ProductRelatednessRecommendation sourceId={sourceId} />
  );
}

function TagPropagationRecommendation({
  sourceId,
}: {
  sourceId: ProductShortcode;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const recommendation = useQuery(
    api.recommendations.tagPropagation.queryOptions({ sourceId }),
  );
  const accept = useMutation(
    api.product.update.mutationOptions({
      onSuccess: () => {
        invalidateTRPCQueries(queryClient, [
          api.recommendations.tagPropagation.queryKey({ sourceId }),
          api.relatedness.product.queryKey(sourceId),
        ]);
      },
    }),
  );
  const dismiss = useMutation(
    api.recommendations.dismissTagPropagation.mutationOptions({
      onSuccess: () => {
        invalidateTRPCQueries(queryClient, [
          api.recommendations.tagPropagation.queryKey({ sourceId }),
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const relatedness = useQuery(
    api.recommendations.product.queryOptions({ sourceId }),
  );
  const dismiss = useMutation(
    api.recommendations.dismissProduct.mutationOptions({
      onSuccess: () => {
        invalidateTRPCQueries(queryClient, [
          api.recommendations.product.queryKey({ sourceId }),
        ]);
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
              <Link
                to="/products/$shortcode"
                params={{ shortcode: item.shortcode as ProductShortcode }}
                className="truncate text-sm hover:underline"
              >
                {item.title}
              </Link>
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
  const api = useTRPC();
  const [merged, setMerged] = useState(false);
  const recommendation = useQuery(
    api.recommendations.duplicateProduct.queryOptions({ sourceId }),
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
      <DuplicateProductMergeFix
        variant={recommendation.data}
        close={() => setMerged(true)}
      />
    </Stack>
  );
}
