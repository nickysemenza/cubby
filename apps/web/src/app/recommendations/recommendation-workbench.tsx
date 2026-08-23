import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";

/** A focused review surface: candidates are always re-resolved, never URL data. */
export function RecommendationWorkbench({
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
      onSuccess: async () => {
        await queryClient.invalidateQueries(
          api.recommendations.product.queryFilter({ sourceId }),
        );
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
