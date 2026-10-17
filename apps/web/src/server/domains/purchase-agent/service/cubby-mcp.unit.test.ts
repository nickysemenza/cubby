/** Failure: the agent's Email read inherits pi's 50 KB head cap and loses a
 * long order's last item lines and totals. */
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { cubbyMcpExtension } from "./cubby-mcp";
import type { McpToolDefinition, RunServices } from "./environment";

describe("cubbyMcpExtension output limits", () => {
  it("raises the Email read tool's output cap above the compact text bound", () => {
    const tool = (name: string) =>
      fromPartial<McpToolDefinition>({
        name,
        description: name,
        inputSchema: { type: "object" },
      });
    const extension = cubbyMcpExtension(
      [tool("imports_read"), tool("entity_read")],
      () => fromPartial<RunServices>({}),
    );
    const limits = Object.fromEntries(
      (extension.tools ?? []).map((t) => [t.name, t.outputLimits]),
    );
    expect(limits["mcp__cubby__imports_read"]?.maxBytes).toBe(200_000);
    expect(limits["mcp__cubby__entity_read"]).toBeUndefined();
  });
});
