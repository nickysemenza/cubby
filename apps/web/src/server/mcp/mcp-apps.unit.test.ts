import { readFileSync } from "node:fs";
import { MCP_APP_BUNDLES } from "@cubby/mcp-apps";
import { MCP_APP_MANIFEST } from "@cubby/mcp-apps/metadata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerMcpApps } from "./apps";
import { listMcpResourceCatalog, listMcpToolCatalog } from "./server";

describe("MCP App resources", () => {
  it("serves every registered UI as a self-contained MCP App document", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpApps(server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri).sort()).toEqual(
        MCP_APP_BUNDLES.map((app) => app.uri).sort(),
      );
      for (const resource of resources) {
        const { contents } = await client.readResource({ uri: resource.uri });
        const [content] = contents;
        expect(content?.mimeType).toBe("text/html;profile=mcp-app");
        expect(content && "text" in content).toBe(true);
        const html = (content as { text: string }).text;
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/u);
        expect(html).not.toContain("__CUBBY_ORIGIN__");
        expect(html).not.toContain("__CUBBY_APP_ID__");
        const app = MCP_APP_MANIFEST.find(
          (candidate) => candidate.uri === resource.uri,
        );
        expect(app).toBeDefined();
        expect(html).toContain(`name="cubby-app-id" content="${app?.id}"`);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps tool metadata, resource pointers, and invocation evals aligned", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const pointedAt = new Set(
      tools.flatMap((tool) => {
        const ui = tool._meta?.ui as { resourceUri?: string } | undefined;
        return ui?.resourceUri ? [ui.resourceUri] : [];
      }),
    );
    const served = new Set(resources.map((resource) => resource.uri));
    expect([...pointedAt].sort()).toEqual(
      MCP_APP_BUNDLES.map((app) => app.uri).sort(),
    );
    expect([...pointedAt].every((uri) => served.has(uri))).toBe(true);
    for (const app of MCP_APP_MANIFEST) {
      expect(
        tools.find((tool) => tool.name === app.toolName)?._meta,
      ).toMatchObject({
        ui: { resourceUri: app.uri },
        "ui/resourceUri": app.uri,
      });
    }
    for (const name of ["get_shopping_list", "search_usda_foods"]) {
      expect(
        tools.find((tool) => tool.name === name)?.outputSchema,
      ).toBeDefined();
    }

    const fixture = JSON.parse(
      readFileSync(
        new URL("./evals/widget-invocation.json", import.meta.url),
        "utf8",
      ),
    ) as {
      cases: Array<{
        category: "direct" | "indirect" | "negative";
        expectedTool: string | null;
        expectedWidget: string | null;
      }>;
    };
    expect(new Set(fixture.cases.map((item) => item.category))).toEqual(
      new Set(["direct", "indirect", "negative"]),
    );
    for (const item of fixture.cases) {
      if (!item.expectedTool) continue;
      const tool = tools.find(
        (candidate) => candidate.name === item.expectedTool,
      );
      expect(tool?.description).toContain("Do not invoke");
      expect(
        (tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
      ).toBe(item.expectedWidget);
    }
  });
});
