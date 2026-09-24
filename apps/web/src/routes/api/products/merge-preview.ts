import {
  mergeProductMatchInput,
  productMergePreview,
} from "@cubby/schemas/recommendations";
import { getErrorMessage } from "@cubby/shared";
import { createFileRoute } from "@tanstack/react-router";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { previewProductMergeDecisions } from "~/server/repo/product/merge";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createRequestContext, requireActor } from "~/server/request-context";

export const Route = createFileRoute("/api/products/merge-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = mergeProductMatchInput.safeParse(await request.json());
        if (!parsed.success)
          return Response.json(
            { error: parsed.error.message },
            { status: 400 },
          );
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        try {
          const [keepId, mergeId] = await Promise.all([
            resolveOrThrow(context.db, "product", parsed.data.keepId),
            resolveOrThrow(context.db, "product", parsed.data.mergeId),
          ]);
          return Response.json(
            productMergePreview.parse(
              await previewProductMergeDecisions(context.db, {
                keepId,
                mergeId,
              }),
            ),
          );
        } catch (error) {
          return Response.json(
            { error: scrubErrorMessage(getErrorMessage(error)) },
            { status: 409 },
          );
        }
      },
    },
  },
});
