import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoServerCodeInClient,
  assertNoDevRoutes,
  assertWasmSplit,
} from "./check-client-bundle";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("client bundle boundary", () => {
  it("rejects local development routes in production output", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cubby-worker-boundary-"),
    );
    try {
      for (const route of [
        "/__dev/login",
        "/__local-storage/s3/",
        "/cdn-cgi/local/explorer",
      ]) {
        await writeFile(
          path.join(directory, "worker.js"),
          `const route = '${route}';`,
        );
        await expect(assertNoDevRoutes(directory)).rejects.toThrow(/local/i);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects server-only markers in every client asset", async () => {
    await expect(
      assertNoServerCodeInClient(fixturePath("clean-assets")),
    ).resolves.toBeUndefined();
    await expect(
      assertNoServerCodeInClient(fixturePath("leaky-assets")),
    ).rejects.toThrow(/drizzle-orm/);
  });
  it("keeps the EPUB module out of the Worker and HTML parsing out of the browser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cubby-wasm-split-"));
    const client = path.join(root, "client");
    const server = path.join(root, "server");
    const write = (directory: string, name: string, exports: string) =>
      writeFile(path.join(directory, name), `\0asm${exports}`);
    try {
      await mkdir(client);
      await mkdir(server);
      await write(
        server,
        "recipebridge_bg-a.wasm",
        "parse_ingredient compact_browser_page",
      );
      await write(client, "recipebridge_bg-b.wasm", "parse_ingredient");
      await write(client, "recipebridge_cookbook_bg-c.wasm", "open_book");
      await expect(assertWasmSplit(client, server)).resolves.toBeUndefined();

      await write(server, "recipebridge_cookbook_bg-c.wasm", "open_book");
      await expect(assertWasmSplit(client, server)).rejects.toThrow(
        /open_book/,
      );
      await rm(path.join(server, "recipebridge_cookbook_bg-c.wasm"));

      await write(client, "recipebridge_bg-d.wasm", "compact_browser_page");
      await expect(assertWasmSplit(client, server)).rejects.toThrow(
        /compact_browser_page/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
