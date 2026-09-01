import { readFileSync } from "node:fs";

import { USDA_PICKER_HTML } from "@cubby/mcp-apps/dev";
import { USDA_PICKER } from "@cubby/mcp-apps/metadata";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";

import { registerMcpApps, resetMcpAppAssetCacheForTests } from "./apps";
import { listMcpResourceCatalog, listMcpToolCatalog } from "./server";

const appResourceContentSchema = z.object({
  mimeType: z.string().optional(),
  text: z.string(),
});
const appToolMetadataSchema = z.object({
  ui: z.object({ resourceUri: z.string().optional() }).optional(),
});
const invocationFixtureSchema = z.object({
  cases: z.array(
    z.object({
      category: z.enum(["direct", "indirect", "negative"]),
      expectedTool: z.string().nullable(),
      expectedWidget: z.string().nullable(),
    }),
  ),
});

describe("MCP App resources", () => {
  afterEach(() => {
    resetMcpAppAssetCacheForTests();
    setCfEnv(undefined);
  });

  it("serves the USDA picker as a self-contained MCP App document", async () => {
    const assetFetch = vi.fn(
      async () =>
        new Response(USDA_PICKER_HTML, {
          headers: { "content-type": "text/html" },
        }),
    );
    setCfEnv(fromPartial<Env>({ ASSETS: { fetch: assetFetch } }));
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
      expect(resources.map((resource) => resource.uri)).toEqual([
        USDA_PICKER.uri,
      ]);
      const { contents } = await client.readResource({ uri: USDA_PICKER.uri });
      const content = appResourceContentSchema.parse(contents[0]);
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      const html = content.text;
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/u);
      expect(html).not.toContain("__CUBBY_ORIGIN__");
      expect(assetFetch).toHaveBeenCalledOnce();

      const secondRead = await client.readResource({ uri: USDA_PICKER.uri });
      expect(appResourceContentSchema.parse(secondRead.contents[0]).text).toBe(
        html,
      );
      expect(assetFetch).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("reloads the USDA picker after the shared-graph test cache is reset", async () => {
    const assetFetch = vi.fn(
      async () => new Response("<!doctype html><p>fresh</p>"),
    );
    setCfEnv(fromPartial<Env>({ ASSETS: { fetch: assetFetch } }));
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
      const { contents } = await client.readResource({ uri: USDA_PICKER.uri });
      expect(appResourceContentSchema.parse(contents[0]).text).toContain(
        "<p>fresh</p>",
      );
      expect(assetFetch).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps the USDA tool, resource pointer, and invocation evals aligned", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const pointedAt = new Set(
      tools.flatMap((tool) => {
        const ui = appToolMetadataSchema.safeParse(tool._meta).data?.ui;
        return ui?.resourceUri ? [ui.resourceUri] : [];
      }),
    );
    const served = new Set(resources.map((resource) => resource.uri));
    expect([...pointedAt]).toEqual([USDA_PICKER.uri]);
    expect([...pointedAt].every((uri) => served.has(uri))).toBe(true);
    expect(
      tools.find((tool) => tool.name === USDA_PICKER.toolName)?._meta,
    ).toMatchObject({
      ui: { resourceUri: USDA_PICKER.uri },
      "ui/resourceUri": USDA_PICKER.uri,
    });
    for (const name of ["get_shopping_list", "search_usda_foods"]) {
      expect(
        tools.find((tool) => tool.name === name)?.outputSchema,
      ).toBeDefined();
    }
    expect(
      tools.find((tool) => tool.name === "get_shopping_list")?._meta,
    ).toBeUndefined();

    const fixture = invocationFixtureSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("./evals/widget-invocation.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(new Set(fixture.cases.map((item) => item.category))).toEqual(
      new Set(["direct", "indirect", "negative"]),
    );
    for (const item of fixture.cases) {
      if (!item.expectedTool) continue;
      const tool = tools.find(
        (candidate) => candidate.name === item.expectedTool,
      );
      expect(tool?.description).toContain("Do not invoke");
      const metadata = appToolMetadataSchema.safeParse(tool?._meta).data;
      expect(metadata?.ui?.resourceUri ?? null).toBe(item.expectedWidget);
    }
  });
});
