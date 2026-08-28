import { type Entity, entitySchema } from "@cubby/schemas/entity-core";
import {
  mcpTelemetryIdentitySchema,
  telemetryMessageV1Schema,
} from "@cubby/schemas/telemetry";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { TraceNames, withTrace } from "~/server/tracing";

import { getRegisteredTool } from "./tool-catalog";
import { installToolCallProtocolHandler } from "./tool-protocol";
import { getToolEntityExtractor } from "./tool-registration";

const telemetryExtraSchema = z.strictObject({
  identity: mcpTelemetryIdentitySchema,
  emit: z.function({
    input: [telemetryMessageV1Schema],
    output: z.promise(z.void()),
  }),
});

function observedToolName(request: CallToolRequest): string | undefined {
  return request.params.name.length > 0 ? request.params.name : undefined;
}

/**
 * Which entity a call acted on, for `McpToolCall.entity`.
 *
 * The extractor belongs to the tool's typed registration. Its result is
 * validated against the public entity discriminant, so telemetry never needs
 * to inspect or retain the argument payload.
 */
function toolCallEntity(
  server: McpServer,
  toolName: string,
  request: CallToolRequest,
): Entity | undefined {
  const extractor = getToolEntityExtractor(server, toolName);
  if (!extractor) return undefined;
  try {
    const parsed = entitySchema.safeParse(
      extractor(request.params.arguments ?? {}),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Observation is best-effort; invalid tool arguments remain the owning
    // registration adapter's validation error and must not break dispatch.
    return undefined;
  }
}

export function installToolCallTelemetryHandler(server: McpServer): void {
  installToolCallProtocolHandler(server, async (dispatch, request, extra) => {
    const toolName = observedToolName(request);
    const spanName = TraceNames.mcp(toolName ?? "unknown");
    return withTrace(spanName, async (span) => {
      const telemetry = telemetryExtraSchema.safeParse(
        extra.authInfo?.extra?.telemetry,
      );
      const registeredAtCall = toolName
        ? getRegisteredTool(server, toolName) !== undefined
        : false;
      span.setAttributes({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": toolName ?? "unknown",
        "mcp.tool.registered": registeredAtCall,
      });

      let outcome: "success" | "error" = "error";
      try {
        const result = await dispatch(request, extra);
        outcome = result.isError === true ? "error" : "success";
        if (outcome === "error") {
          span.setError("MCP tool returned an error");
        }
        return result;
      } catch (error) {
        span.setError("MCP tool dispatch failed");
        throw error;
      } finally {
        if (toolName && telemetry.success) {
          try {
            await telemetry.data.emit({
              version: 1,
              eventId: crypto.randomUUID(),
              occurredAt: new Date().toISOString(),
              release: __GIT_COMMIT__,
              type: "mcp_tool_call",
              toolName,
              outcome,
              registeredAtCall,
              entity: toolCallEntity(server, toolName, request),
              ...telemetry.data.identity,
            });
          } catch (error) {
            console.error("[MCP telemetry] failed to record tool call", {
              toolName,
              error,
            });
          }
        }
      }
    });
  });
}
