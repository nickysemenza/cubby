import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { Badge } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";
import { TruncatedList } from "~/ui/TruncatedList";

import type { ListRenderer } from "../list-renderer-types";

const usdaFoodLink: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.display({
        id: "food",
        header: "USDA Food",
        // No mobile slot: a display column escapes the model's empty-value
        // check, and most products have no USDA link.
        meta: { className: "w-32" },
        cell: ({ row }) => {
          const food = row.original.food;
          return food ? (
            <EntityRefLink
              displayImage={null}
              entity="usda-food"
              data={food}
              compact
            />
          ) : (
            <NoneValue />
          );
        },
      }),
    );
  });

// Read-only: the Tags filter spec declares `columnId: "tags"`, and the
// header-filter machinery needs a real column to hang on.
const tagLinks: ListRenderer<"product"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("tags", {
        id: "tags",
        header: "Tags",
        meta: { className: "w-40", mobile: { slot: "meta", priority: 60 } },
        cell: (info) => {
          const tags = info.getValue();
          if (!tags.length) return <NoneValue />;
          return (
            <TruncatedList
              items={tags}
              maxItems={2}
              // `stopPropagation`: rows carry the preview onRowClick and
              // TanStack's Link preventDefaults without stopping propagation,
              // so the chip would also open the sheet.
              renderItem={(tag) => (
                <Link
                  key={tag}
                  to="/products"
                  search={{ tags: tag }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="outline">{tag}</Badge>
                </Link>
              )}
            />
          );
        },
      }),
    );
  });

export const productListRenderers = {
  "usda-food-link": usdaFoodLink,
  "tag-links": tagLinks,
} as const;
