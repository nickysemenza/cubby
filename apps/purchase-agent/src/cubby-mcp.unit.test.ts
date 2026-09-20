import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { cubbyMcpConnection } from "./cubby-mcp";
import type { PurchaseImportService } from "./service";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("cubbyMcpConnection", () => {
  it("resolves run-bound auth per request and proxies through the service binding", async () => {
    const mcpFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://mcp.internal.test/api/mcp?session=7");
      expect(request.headers.get("authorization")).toBe("Bearer run-token");
      return new Response("ok");
    });
    const unavailable = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected agent service call");
    });
    const service: PurchaseImportService = {
      acquireMcpAccess: vi.fn(async () => ({
        token: "run-token",
        expiresAt: "2026-09-20T20:00:00.000Z",
        mcpUrl: "https://mcp.internal.test/api/mcp",
      })),
      mcpFetch,
      claimNextWork: unavailable,
      extractReceiptEvidence: unavailable,
      issueBrowserCommand: unavailable,
      readBrowserCommandResult: unavailable,
      saveNavigationHints: unavailable,
      markHistoryExpired: unavailable,
      finishRun: unavailable,
      stopForReview: unavailable,
      recordAgentUsage: unavailable,
      updateAgentProgress: unavailable,
      markRunFailed: unavailable,
    };
    const connection = cubbyMcpConnection(runId, () => service);
    if (!connection.fetch) {
      throw new Error("Expected dynamic MCP auth and fetch");
    }
    const authenticate = z
      .function({ input: [], output: z.promise(z.string()) })
      .parse(connection.auth);

    await expect(authenticate()).resolves.toBe("run-token");
    const response = await connection.fetch(
      "https://cubby-mcp.invalid/mcp?session=7",
      { headers: { authorization: "Bearer run-token" } },
    );

    expect(await response.text()).toBe("ok");
    expect(service.acquireMcpAccess).toHaveBeenCalledWith({ runId });
    expect(service.acquireMcpAccess).toHaveBeenCalledOnce();
    expect(mcpFetch).toHaveBeenCalledOnce();
  });
});
