import { recommendationWorkbenchSearch } from "@cubby/schemas/recommendations";
import { createFileRoute, redirect } from "@tanstack/react-router";

/** Retained bookmarks keep their record scope; review has one home. */
export const Route = createFileRoute(
  "/_authenticated/recommendations/workbench",
)({
  validateSearch: recommendationWorkbenchSearch,
  beforeLoad: ({ search }) => {
    if (search.kind === "product-related" && search.source)
      throw redirect({
        to: "/products/$shortcode",
        params: { shortcode: search.source },
      });
    throw redirect({
      to: "/suggestions",
      search: {
        family:
          search.kind === "product-match" || search.kind === "duplicate-product"
            ? "product_pair"
            : "recommendation",
        record: search.inventory
          ? `inventory:${search.inventory}`
          : search.source
            ? `product:${search.source}`
            : undefined,
      },
    });
  },
});
