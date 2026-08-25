import { productCreateManyInput } from "@cubby/schemas/product";
import { createFileRoute } from "@tanstack/react-router";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import {
  createManyProductsWorkflow,
  productCreateManyEvent,
} from "~/server/workflows/product.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "product.createMany",
    inputSchema: productCreateManyInput,
    eventSchema: productCreateManyEvent,
    run: (context, input) => createManyProductsWorkflow(context, input),
  });

export const Route = createFileRoute("/api/product-stream/create-many")({
  server: { handlers: { POST: post } },
});
