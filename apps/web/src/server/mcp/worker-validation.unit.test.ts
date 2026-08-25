import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentToolset } from "../agent/mcp-bridge";
import type { McpWorkflowCaller } from "./workflow-caller";

async function withoutDynamicCode<T>(run: () => Promise<T>): Promise<T> {
  const previousJitless = z.config().jitless;

  // Zod normally discovers the Worker's restriction during module setup. Tests
  // run in Node, so disable its optional JIT before loading the MCP schemas and
  // reserve the throwing Function stub for catching an AJV regression.
  z.config({ jitless: true });
  await import("./server");
  vi.stubGlobal("Function", function forbiddenFunction() {
    throw new EvalError("Code generation from strings disallowed");
  });

  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
    z.config({ jitless: previousJitless });
  }
}

describe("MCP clients on Cloudflare Workers", () => {
  it("lists the inspector catalog without generating validator code", async () => {
    await withoutDynamicCode(async () => {
      const { listMcpToolCatalog } = await import("./server");
      const { tools } = await listMcpToolCatalog();
      expect(tools.length).toBeGreaterThan(0);
    });
  }, 15_000);

  it("builds the agent toolset without generating validator code", async () => {
    let close: (() => Promise<void>) | undefined;

    try {
      await withoutDynamicCode(async () => {
        const toolset = await createAgentToolset({} as McpWorkflowCaller);
        close = toolset.close;
        expect(toolset.tools.length).toBeGreaterThan(0);
      });
    } finally {
      await close?.();
    }
  }, 15_000);
});
