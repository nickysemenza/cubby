import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { ProductTagSiblingsOut } from "@cubby/schemas/product";
import { formatCategoryLabel } from "@cubby/shared";
import { isCollectionTag } from "@cubby/shared/collection-tag";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { keyBy } from "es-toolkit";
import { MapPin } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { useTRPC } from "~/integrations/trpc/react";
import { EntityInlineLink } from "../EntityInlineLink";

const NO_SIBLINGS: ProductTagSiblingsOut["siblings"] = [];
const NO_TAG_STORAGE: ProductTagSiblingsOut["tagStorage"] = [];

/**
 * "Fits With" — the other products sharing each of this product's tags, and
 * where that tag's family is stocked.
 *
 * A tag records class compatibility, not a directed edge, so the useful reading
 * of a group is "everything in this ecosystem" — the grinder next to its discs.
 * `category` supplies the direction the tag deliberately omits, so each sibling
 * shows its own ("tools" vs "tool consumables") and the pairing reads correctly
 * from either side.
 *
 * The storage lines are the put-away half: the roster says what belongs with
 * this, the locations say where that already lives, so a new battery in hand
 * lands with the rest of the kit without opening four siblings. They're per tag
 * rather than one rollup because the ecosystems are stored separately — the
 * M18 shelf is not the Festool shelf — and counted by distinct product, so
 * "3 M18 things live here" can't be inflated by one product split across two
 * entries. The `MapPin` marks a location this product is already stocked in,
 * which is the difference between "put it here" and "you're already here".
 *
 * The tag heading links to the filtered list, which is the same group with the
 * full table around it.
 */
export function ProductTagSiblings({
  product,
}: {
  product: { id: ProductShortcode; tags: string[] };
}) {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.product.tagSiblings.queryOptions(product.id),
  );

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  const storageByTag = keyBy(data?.tagStorage ?? NO_TAG_STORAGE, (s) => s.tag);

  // Group by the source product's own tags, preserving their stored order. A
  // sibling matched via `arrayOverlaps` can share more than one tag, so it
  // legitimately appears under each — the Domino shows up under both
  // `festool-ct` and `domino-tenons`.
  const compatibilityTags = product.tags.filter((tag) => !isCollectionTag(tag));
  const groups = compatibilityTags
    .map((tag) => ({
      tag,
      siblings: (data?.siblings ?? NO_SIBLINGS).filter((s) =>
        s.tags.includes(tag),
      ),
      storage: storageByTag[tag],
    }))
    .filter((g) => g.siblings.length > 0);

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No other products share{" "}
        {compatibilityTags.length > 0 ? "these tags" : "a compatibility tag"}{" "}
        yet.
      </p>
    );
  }

  return (
    <Stack gap="sm">
      {groups.map(({ tag, siblings, storage }) => (
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
          {storage && (
            // Storage before the roster: where the family lives is the
            // actionable half, the names are the evidence for it.
            <Stack gap="tight" className="mb-1">
              {storage.locations.map((loc) => {
                const path = [...loc.ancestors.map((a) => a.name), loc.name];
                const parent = loc.ancestors.at(-1);
                return (
                  <Row key={loc.id} align="center" justify="between" gap="sm">
                    <Row align="center" gap="tight" className="min-w-0">
                      {loc.holdsSource && (
                        <MapPin
                          className="size-3 shrink-0 text-plum"
                          aria-label="Stocked here too"
                        />
                      )}
                      {parent && (
                        <span
                          className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground"
                          title={path.join(" › ")}
                        >
                          {parent.name} ›
                        </span>
                      )}
                      <EntityInlineLink
                        displayImage={undefined}
                        entity="location"
                        data={{ id: loc.id, name: loc.name }}
                        truncate
                      />
                    </Row>
                    <span className="shrink-0 font-mono text-slate text-xs">
                      ·{loc.productCount}
                    </span>
                  </Row>
                );
              })}
              {storage.omittedLocationCount > 0 && (
                <span className="text-2xs text-muted-foreground">
                  +{storage.omittedLocationCount} more location
                  {storage.omittedLocationCount === 1 ? "" : "s"}
                </span>
              )}
            </Stack>
          )}
          <Stack gap="tight">
            {siblings.map((sibling) => (
              <Row key={sibling.id} align="center" justify="between" gap="sm">
                <EntityInlineLink
                  displayImage={undefined}
                  entity="product"
                  data={{
                    id: sibling.id,
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
