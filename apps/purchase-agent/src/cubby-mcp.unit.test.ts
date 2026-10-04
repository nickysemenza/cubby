import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { cubbyMcpFetch, mountedMcpTools } from "./cubby-mcp";
import type { PurchaseImportService } from "./service";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("Cubby MCP for an import run", () => {
  it("mounts only the photo workflow tools for photo inventory runs", () => {
    const catalog = [
      "imports_read",
      "entity_read",
      "entity",
      "search",
      "photo_run",
      "product_enrichment",
    ].map((name) => ({ name, inputSchema: { type: "object" } }));

    expect(
      mountedMcpTools("photo_inventory", catalog).map((tool) => tool.name),
    ).toEqual([
      "imports_read",
      "entity_read",
      "search",
      "photo_run",
      "product_enrichment",
    ]);
  });

  it("resolves run-bound auth per request and proxies through the service binding", async () => {
    const mcpFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://mcp.internal.test/api/mcp?session=7");
      expect(request.headers.get("authorization")).toBe("Bearer run-token");
      return new Response("ok");
    });
    const acquireMcpAccess = vi.fn(async () => ({
      token: "run-token",
      expiresAt: "2026-09-20T20:00:00.000Z",
      mcpUrl: "https://mcp.internal.test/api/mcp",
    }));
    // The MCP transport reaches only these two service methods.
    const service = fromPartial<PurchaseImportService>({
      acquireMcpAccess,
      mcpFetch,
    });

    const response = await cubbyMcpFetch(runId, () => service)(
      "https://cubby-mcp.invalid/mcp?session=7",
      { method: "POST", body: "{}" },
    );

    expect(await response.text()).toBe("ok");
    expect(acquireMcpAccess).toHaveBeenCalledWith({ runId });
    expect(mcpFetch).toHaveBeenCalledOnce();
  });
});
