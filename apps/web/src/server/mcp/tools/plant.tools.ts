import { resolvePlantsInput, resolvePlantsOutput } from "@cubby/schemas/plant";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveOrCreatePlants } from "~/server/repo/plant";

import { registerRouterTool, WRITE_CLOSED } from "./_shared";

export function registerPlantTools(server: McpServer) {
  registerRouterTool(server, {
    name: "resolve_plants",
    description:
      "Batch-resolve cultivar or species names to PLANT- ids in one call. Each `{ name, gardenGuideKey?, ingredientName? }` matches a live Plant by name (case-insensitive) within the crop key when given, or is created; `ingredientName` only fills a created Plant's informational ingredient link. Returns `created` per row.",
    inputSchema: resolvePlantsInput,
    outputSchema: resolvePlantsOutput,
    annotations: WRITE_CLOSED,
    call: (context, params) =>
      resolveOrCreatePlants(context.db, params, context.actorContext),
  });
}
