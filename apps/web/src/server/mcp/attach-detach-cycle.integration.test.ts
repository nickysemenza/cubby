/**
 * The attach → detach → re-attach cycle, and the entity delete, driven through
 * the real MCP server against a real Postgres.
 *
 * Regression cover for a bug that made `attach_file` lie. Detaching an image
 * hard-deleted only the join row, leaving the `Image` alive with `deletedAt`
 * NULL, `status` UPLOADED, its `targetType`/`targetId`/`idempotencyKey` intact
 * and its object still in R2. Two things followed:
 *
 * 1. The bytes leaked. `cullPendingImages` only ever reaps PENDING rows, so
 *    nothing collected them — 133 rows / 68 MB had piled up in production.
 * 2. `findAttachmentByIdempotencyKey` matched on the target columns alone, so a
 *    retry with the SAME key found that detached row and returned it as a
 *    success. No upload, no join row, `imageCount` unchanged, and a response
 *    byte-identical to a real attach.
 *
 * Entity DELETES leaked the same way (50 of those orphans): `removeEntity`
 * cascaded a *soft* delete onto the join rows and never touched the file.
 *
 * This file asserts what a CLIENT can see — `reused`, `imageCount`, and which
 * R2 objects were dropped — because that is the surface the bug lied on: the
 * response was indistinguishable from a real attach. The row-level half (the
 * `Image` row being gone rather than merely orphaned, and which references keep
 * it alive) is asserted in repo/image.integration.test.ts, where unwrapping the
 * opaque `Database` belongs.
 */

import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

// The only stubbed seam: the R2 network calls. Everything else — the row and
// join insert, the reference probes, the reap — runs for real against the test
// database. Mirrors repo/purchase.integration.test.ts.
vi.mock("~/server/utils/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/server/utils/s3")>()),
  uploadToS3: vi.fn(async () => undefined),
  deleteS3Object: vi.fn(async () => undefined),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DomainCaller } from "~/server/api/domain";
import { domainRouter } from "~/server/api/domain";
import { createTestCaller } from "~/server/api/trpc";
import { deleteS3Object, extractKeyFromUrl } from "~/server/utils/s3";
import { createMcpServer } from "./server";

/** A 1×1 PNG — real bytes, so `inspectImageFile`'s signature and dimension
 * checks run rather than being stubbed around. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Mirrors `callTool` in mcp-shortcode-boundary.integration.test.ts: a fresh
 * server per call (McpServer.connect runs once per instance), with a REAL tRPC
 * caller injected over the production `authInfo.extra.caller` channel. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: DomainCaller,
): Promise<CallToolResult> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { token: "", clientId: "test", scopes: [], extra: { caller } },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function errorText(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function expectOk(result: CallToolResult) {
  expect(result.isError, errorText(result)).not.toBe(true);
}

describe("attach_file / detach cycle", () => {
  const ctx = withTestDb("mcp");

  const makeCaller = () => createTestCaller(domainRouter, ctx.db);

  const createProduct = async (caller: DomainCaller, name: string) => {
    const created = await callTool(
      "create_product",
      { name, manufacturer: "Test Mfg", upc: null, ingredientId: null },
      caller,
    );
    expectOk(created);
    return structured(created).id as string;
  };

  const attach = async (
    caller: DomainCaller,
    entityCode: string,
    idempotencyKey: string,
    filename: string,
  ) => {
    const result = await callTool(
      "attach_file",
      {
        entityId: entityCode,
        data: PNG_BASE64,
        contentType: "image/png",
        filename,
        idempotencyKey,
      },
      caller,
    );
    expectOk(result);
    return structured(result);
  };

  const imageCountOf = async (caller: DomainCaller, productCode: string) => {
    const got = await callTool("get_product", { id: productCode }, caller);
    expectOk(got);
    return structured(got).imageCount;
  };

  /** The stored key, from the response's own url — no DB read needed, and it
   * doubles as a check that the returned url really names the stored object. */
  const storedKeyOf = (attached: Record<string, unknown>) => {
    const key = extractKeyFromUrl(attached.url as string);
    expect(key).toBeTruthy();
    return key;
  };

  it("re-attaching after a detach uploads again instead of replaying the dead row", async () => {
    const caller = makeCaller();
    const productCode = await createProduct(caller, "Cycle Widget");

    const first = await attach(caller, productCode, "k1", "cover.png");
    expect(first.reused).toBe(false);
    const firstImageId = first.imageId as string;
    const firstKey = storedKeyOf(first);
    // A returned imageId is what the broken version produced too — the count is
    // what actually proves the file landed.
    expect(await imageCountOf(caller, productCode)).toBe(1);
    vi.mocked(deleteS3Object).mockClear();

    const removed = await callTool(
      "update_product",
      { id: productCode, removeImageIds: [firstImageId] },
      caller,
    );
    expectOk(removed);

    expect(await imageCountOf(caller, productCode)).toBe(0);
    // The file went with the association — the assertion the bug failed.
    expect(vi.mocked(deleteS3Object)).toHaveBeenCalledWith(firstKey);

    // The same key again. Previously this returned the detached row with a
    // success payload and attached nothing.
    const second = await attach(caller, productCode, "k1", "cover-again.png");
    expect(second.reused).toBe(false);
    expect(second.imageId).not.toBe(firstImageId);
    expect(await imageCountOf(caller, productCode)).toBe(1);
  });

  it("replays a genuine retry while the file is still attached", async () => {
    const caller = makeCaller();
    const productCode = await createProduct(caller, "Replay Widget");

    const first = await attach(caller, productCode, "k2", "cover.png");
    expect(first.reused).toBe(false);

    const retry = await attach(caller, productCode, "k2", "cover.png");
    // Identity, not upload call counts: the transactional-winner path uploads
    // before it discovers it lost, so a call count proves nothing here.
    expect(retry.reused).toBe(true);
    expect(retry.imageId).toBe(first.imageId);
    expect(await imageCountOf(caller, productCode)).toBe(1);
  });

  /**
   * The other half of the leak, end to end. A delete cascades a SOFT delete onto
   * the join row, so "is it still attached?" answers yes-it's-gone either way —
   * only the R2 object tells the fix from the bug at this layer.
   */
  describe("deleting the owning entity takes the file with it", () => {
    it("drops a deleted product's R2 object", async () => {
      const caller = makeCaller();
      const productCode = await createProduct(caller, "Doomed Widget");
      const attached = await attach(caller, productCode, "d1", "doomed.png");
      const key = storedKeyOf(attached);
      vi.mocked(deleteS3Object).mockClear();

      expectOk(
        await callTool(
          "delete_entity",
          { entity: "product", ids: [productCode] },
          caller,
        ),
      );

      expect(vi.mocked(deleteS3Object)).toHaveBeenCalledWith(key);
    });

    it("drops a deleted recipe's R2 object", async () => {
      const caller = makeCaller();
      const created = await callTool(
        "create_recipe",
        { name: "Doomed Recipe", meta: { url: null }, sections: [] },
        caller,
      );
      expectOk(created);
      const recipeCode = structured(created).id as string;

      const attached = await attach(caller, recipeCode, "d2", "recipe.png");
      const key = storedKeyOf(attached);
      vi.mocked(deleteS3Object).mockClear();

      // Recipes reach `removeEntity` with `recipeImage` DECLARED in `children`
      // rather than hand-rolled above the call — this is what proves the
      // declaration is what makes the reap visible.
      expectOk(
        await callTool(
          "delete_entity",
          { entity: "recipe", ids: [recipeCode] },
          caller,
        ),
      );

      expect(vi.mocked(deleteS3Object)).toHaveBeenCalledWith(key);
    });
  });
});
