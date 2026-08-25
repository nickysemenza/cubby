import { productMarkUsdaUnavailableManyInput } from "@cubby/schemas/product";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import {
  markProductsUsdaUnavailableWorkflow,
  productMarkUsdaUnavailableEvent,
} from "~/server/workflows/product.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "product.markUsdaUnavailableMany",
    inputSchema: productMarkUsdaUnavailableManyInput,
    eventSchema: productMarkUsdaUnavailableEvent,
    run: (context, input) =>
      markProductsUsdaUnavailableWorkflow(context, input),
  });

export const Route = createFileRoute(
  "/api/product-stream/mark-usda-unavailable",
)({ server: { handlers: { POST: post } } });
