import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { workflowStreamResponse } from "~/server/workflow-stream.server";
import {
  backfillProductUpcImagesWorkflow,
  productBackfillUpcImagesEvent,
} from "~/server/workflows/product.server";

const post = ({ request }: { request: Request }) =>
  workflowStreamResponse({
    request,
    operation: "product.backfillUPCImages",
    inputSchema: z.undefined(),
    eventSchema: productBackfillUpcImagesEvent,
    run: (context) => backfillProductUpcImagesWorkflow(context),
  });

export const Route = createFileRoute("/api/product-stream/backfill-upc-images")(
  { server: { handlers: { POST: post } } },
);
