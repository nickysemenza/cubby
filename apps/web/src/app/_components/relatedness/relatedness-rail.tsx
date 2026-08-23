import type { ProductShortcode } from "@cubby/schemas/identifiers";
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

      {relatedness.data?.items.map(({ shortcode, title, score }) => (
        <Row
          key={shortcode}
          align="center"
          justify="between"
          gap="sm"
          className="border-border border-b pb-1 last:border-b-0"
        >
          <Link
            to="/products/$shortcode"
            params={{ shortcode }}
            className="min-w-0 truncate text-sm hover:underline"
          >
            {title}
          </Link>
          <span className="shrink-0 font-mono text-2xs text-slate">
            {Math.round(score * 100)}% similar
          </span>
        </Row>
      ))}

      {relatedness.data?.groups.map((group) => (
        <div key={group.label} className="border-border border-t pt-2">
          <Row align="baseline" justify="between" className="mb-1">
            <span className="text-xs">{group.label}</span>
            <span className="font-mono text-2xs text-slate">
              {group.items.length} related
            </span>
          </Row>
          <Stack gap="tight">
            {group.items.slice(0, 4).map((item) => (
              <Link
                key={item.shortcode}
                to="/products/$shortcode"
                params={{ shortcode: item.shortcode as ProductShortcode }}
                className="truncate text-sm hover:underline"
              >
                {item.title}
              </Link>
            ))}
          </Stack>
        </div>
      ))}

      {status === "ready" &&
        relatedness.data?.items.length === 0 &&
        relatedness.data.groups.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No related products yet.
          </p>
        )}
    </Stack>
  );
}
