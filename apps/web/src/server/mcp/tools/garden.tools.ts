import {
  gardenFinishPlantingInput,
  gardenMovePlantingInput,
  gardenStartPlantingInput,
  plantingOut,
} from "@cubby/schemas/garden";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getCaller, registerMcpTool, WRITE_CLOSED } from "./_shared";

export function registerGardenTools(server: McpServer) {
  registerMcpTool(server, {
    name: "start_planting",
    description:
      "Start a planned planting at a location. This records its lifecycle and location history; do not use entity update to change status or location.",
    inputSchema: gardenStartPlantingInput,
    outputSchema: plantingOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => getCaller(extra).garden.startPlanting(params),
  });

  registerMcpTool(server, {
    name: "move_planting",
    description:
      "Move a growing planting to another location and record the location transition. This preserves the planting journal and dated location history.",
    inputSchema: gardenMovePlantingInput,
    outputSchema: plantingOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => getCaller(extra).garden.movePlanting(params),
  });

  registerMcpTool(server, {
    name: "finish_planting",
    description:
      "Finish a planned or growing planting. Use this when a plant dies, is discarded, or the season ends; optionally record a note explaining what happened.",
    inputSchema: gardenFinishPlantingInput,
    outputSchema: plantingOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => getCaller(extra).garden.finishPlanting(params),
  });
}
