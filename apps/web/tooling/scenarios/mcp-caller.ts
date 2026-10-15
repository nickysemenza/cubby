import type { CubbyMcpToolAction } from "@cubby/schemas/mcp-tools";

import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";

import type { KernelContext } from "./context";

/**
 * Call an MCP `tool.action` through the real server with the kernel context,
 * throwing on a tool error and returning the structured result for the caller
 * to parse with its own output schema.
 */
export function makeMcpCaller(kernel: KernelContext) {
  return async (
    name: CubbyMcpToolAction,
    args: Parameters<typeof callMcpTool>[2],
  ) => {
    const [tool, action] = name.split(".");
    const result = await callMcpTool(
      createMcpServer(),
      tool!,
      { action, ...args },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    if (result.isError)
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return result.structuredContent;
  };
}
