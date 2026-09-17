import { describe, expect, it } from "vitest";
import { z } from "zod";

async function withoutDynamicCode<T>(run: () => Promise<T>): Promise<T> {
  const previousRunJitless = z.config().jitless;
  const functionDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Function",
  );
  if (!functionDescriptor) throw new Error("Function global is unavailable");
  const forbiddenFunction = new Proxy(globalThis.Function, {
    apply() {
      throw new EvalError("Code generation from strings disallowed");
    },
    construct() {
      throw new EvalError("Code generation from strings disallowed");
    },
  });

  // Keep Zod on its Worker-safe path and catch any validator regression while
  // the catalog operation itself runs.
  z.config({ jitless: true });
  Object.defineProperty(globalThis, "Function", {
    ...functionDescriptor,
    value: forbiddenFunction,
  });

  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, "Function", functionDescriptor);
    z.config({ jitless: previousRunJitless });
  }
}

// Transform and initialize the real server outside the per-operation timeout,
// with the same Worker restriction already active.
const mcpServer = await withoutDynamicCode(() => import("./server"));

describe("MCP clients on Cloudflare Workers", () => {
  it("lists the inspector catalog without generating validator code", async () => {
    await withoutDynamicCode(async () => {
      const { tools } = await mcpServer.listMcpToolCatalog();
      expect(tools.length).toBeGreaterThan(0);
    });
  }, 30_000);
});
