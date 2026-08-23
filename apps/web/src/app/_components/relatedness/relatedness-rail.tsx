import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { isCollectionTag } from "@cubby/shared/collection-tag";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";

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
  const similar = useQuery(
    api.search.similar.queryOptions({
      pair: "product_to_product",
      sourceId: product.id,
      limit: 5,
    }),
  );
  const tags = useQuery(api.product.tagSiblings.queryOptions(product.id));
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

  const compatibilityTags = product.tags.filter((tag) => !isCollectionTag(tag));
  const tagGroups = compatibilityTags
    .map((tag) => ({
      tag,
      siblings: (tags.data?.siblings ?? []).filter((sibling) =>
        sibling.tags.includes(tag),
      ),
    }))
    .filter((group) => group.siblings.length > 0);
  const status = similar.data?.status;
  const indexing =
    batch.data?.status === "queued" || batch.data?.status === "running";

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

      {similar.data?.results.map(({ entity, similarity }) => (
        <Row
          key={entity.id}
          align="center"
          justify="between"
          gap="sm"
          className="border-border border-b pb-1 last:border-b-0"
        >
          <Link
            to="/products/$shortcode"
            params={{ shortcode: entity.id }}
            className="min-w-0 truncate text-sm hover:underline"
          >
            {entity.title}
          </Link>
          <span className="shrink-0 font-mono text-2xs text-slate">
            {Math.round(similarity * 100)}% similar
          </span>
        </Row>
      ))}

      {tagGroups.map(({ tag, siblings }) => (
        <div key={tag} className="border-border border-t pt-2">
          <Row align="baseline" justify="between" className="mb-1">
            <Link
              to="/products"
              search={{ tags: tag }}
              className="text-xs underline"
            >
              {tag}
            </Link>
            <span className="font-mono text-2xs text-slate">
              {siblings.length} compatible
            </span>
          </Row>
          <Stack gap="tight">
            {siblings.slice(0, 4).map((sibling) => (
              <Link
                key={sibling.id}
                to="/products/$shortcode"
                params={{ shortcode: sibling.id }}
                className="truncate text-sm hover:underline"
              >
                {sibling.name}
              </Link>
            ))}
          </Stack>
        </div>
      ))}

      {status === "ready" &&
        similar.data?.results.length === 0 &&
        tagGroups.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No related products yet.
          </p>
        )}
    </Stack>
  );
}
