import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createMcpServer } from "../mcp/server";
import type { Env } from "../types";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";

import { createDb, schema } from "./index";
import { listProducts } from "./products";

it("returns an exact non-page-aligned offset while retaining admin page pagination", async () => {
  const platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  try {
    const migrations = new URL("../../drizzle/", import.meta.url);
    for (const filename of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(filename, migrations), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        await platform.env.DB.prepare(statement).run();
      }
    }
    const db = createDb(platform.env.DB);
    const rows = Array.from({ length: 35 }, (_, index) => ({
      upc: String(index).padStart(12, "0"),
      name: `Pagination product ${index}`,
      source: "test",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    for (const row of rows) await db.insert(schema.products).values(row);
    const expected = rows.toReversed().map((row) => row.upc);
    const server = createMcpServer(platform.env, "https://upc.test");
    const client = new Client({ name: "pagination-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "search_products",
        arguments: { q: "Pagination", offset: 10, limit: 20 },
      });
      expect(result.isError).not.toBe(true);
      const content = z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .parse(result.content);
      const page = z
        .object({
          products: z.array(z.object({ upc: z.string() })),
          total: z.number(),
        })
        .parse(JSON.parse(content[0]!.text));
      expect(page.products.map((row) => row.upc)).toEqual(
        expected.slice(10, 30),
      );
      expect(page.total).toBe(rows.length);
    } finally {
      await client.close();
      await server.close();
    }
    const adminPage = await listProducts(db, { page: 2, pageSize: 20 });
    expect(adminPage.rows.map((row) => row.upc)).toEqual(expected.slice(20));
  } finally {
    await platform.dispose();
  }
}, 30_000);
