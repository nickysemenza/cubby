import type { ProductId } from "@cubby/schemas/identifiers";
import { formatCategoryLabel } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { EntityInlineLink } from "../EntityInlineLink";

/**
 * "Fits With" — the other products sharing each of this product's tags.
 *
 * A tag records class compatibility, not a directed edge, so the useful reading
 * of a group is "everything in this ecosystem" — the grinder next to its discs.
 * `category` supplies the direction the tag deliberately omits, so each sibling
 * shows its own ("tools" vs "tool consumables") and the pairing reads correctly
 * from either side.
 *
 * The tag heading links to the filtered list, which is the same group with the
 * full table around it.
 */
export function ProductTagSiblings({
  product,
}: {
  product: { id: ProductId; tags: string[] };
}) {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.product.tagSiblings.queryOptions(product.id),
  );

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  // Group by the source product's own tags, preserving their stored order. A
  // sibling matched via `arrayOverlaps` can share more than one tag, so it
  // legitimately appears under each — the Domino shows up under both
  // `festool-ct` and `domino-tenons`.
  const groups = product.tags
    .map((tag) => ({
      tag,
      siblings: (data ?? []).filter((s) => s.tags.includes(tag)),
    }))
    .filter((g) => g.siblings.length > 0);

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No other products share{" "}
        {product.tags.length > 0 ? "these tags" : "a tag"} yet.
      </p>
    );
  }

  return (
    <Stack gap="sm">
      {groups.map(({ tag, siblings }) => (
        <div
          key={tag}
          className="border-[var(--border)] border-t pt-2 first:border-t-0 first:pt-0"
        >
          <Row align="baseline" justify="between" className="mb-1">
            <Link to="/products" search={{ tags: tag }}>
              <Badge variant="outline">{tag}</Badge>
            </Link>
            <span className="font-mono text-slate text-xs">
              {siblings.length} other{siblings.length === 1 ? "" : "s"}
            </span>
          </Row>
          <Stack gap="tight">
            {siblings.map((sibling) => (
              <Row key={sibling.id} align="center" justify="between" gap="sm">
                <EntityInlineLink
                  entity="product"
                  data={{
                    id: sibling.id,
                    shortcode: sibling.shortcode,
                    name: sibling.name,
                    manufacturer: sibling.manufacturer,
                  }}
                  truncate
                />
                {sibling.category && (
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatCategoryLabel(sibling.category)}
                  </span>
                )}
              </Row>
            ))}
          </Stack>
        </div>
      ))}
    </Stack>
  );
}
