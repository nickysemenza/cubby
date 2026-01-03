/**
 * Shortcode redirect route
 *
 * Handles URLs like /L-A3F2 or /P-X7K9 and redirects to the appropriate entity page.
 * Used for QR code labels that encode the shortcode URL.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";
import { parseShortcode } from "~/lib/shortcode";

export const Route = createFileRoute("/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const { shortcode } = params;

    // Parse shortcode to determine entity type
    const parsed = parseShortcode(shortcode);
    if (!parsed) {
      // Not a valid shortcode format - let it fall through to 404
      throw new Error("Invalid shortcode format");
    }

    // Look up the entity by shortcode
    if (parsed.type === "location") {
      const location = await context.queryClient.fetchQuery(
        context.trpc.location.getByShortcode.queryOptions({ shortcode }),
      );
      if (!location) {
        throw new Error("Location not found");
      }
      throw redirect({
        to: "/locations/$id",
        params: { id: location.id },
        replace: true,
      });
    }

    if (parsed.type === "product") {
      const product = await context.queryClient.fetchQuery(
        context.trpc.product.getByShortcode.queryOptions({ shortcode }),
      );
      if (!product) {
        throw new Error("Product not found");
      }
      throw redirect({
        to: "/products/$id",
        params: { id: product.id },
        replace: true,
      });
    }

    // Should never reach here
    throw new Error("Unknown shortcode type");
  },
  component: () => null, // We always redirect before rendering
});
