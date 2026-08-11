/**
 * The attach → detach → re-attach cycle, driven through the real MCP server
 * against a real Postgres.
 *
 * Regression cover for a bug that made `attach_file` lie. Detaching an image
 * hard-deleted only the join row, leaving the `Image` alive with `deletedAt`
 * NULL, `status` UPLOADED, its `targetType`/`targetId`/`idempotencyKey` intact
 * and its object still in R2. Two things followed:
 *
 * 1. The bytes leaked. `cullPendingImages` only ever reaps PENDING rows, so
 *    nothing collected them — 132 rows / 68 MB had piled up in production.
 * 2. `findAttachmentByIdempotencyKey` matched on the target columns alone, so a
 *    retry with the SAME key found that detached row and returned it as a
 *    success. No upload, no join row, `imageCount` unchanged, and a response
 *    byte-identical to a real attach.
 *
 * Both assertions below are about what a passing-but-wrong implementation would
 * still produce: a returned `imageId` proves nothing, so the tests read the join
 * row and `get_product`'s `imageCount`; and "the image is gone" is checked with
 * an UNFILTERED select, because a `notDeleted` read cannot tell a deleted row
 * from an orphaned one.
 */

import { eq } from "drizzle-orm";
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
import type { Database } from "~/server/db";
import { image, productImage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { deleteS3Object } from "~/server/utils/s3";
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
    productCode: string,
    idempotencyKey: string,
    filename: string,
  ) => {
    const result = await callTool(
      "attach_file",
      {
        entityId: productCode,
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

  /** Unfiltered on purpose: a `notDeleted` read passes whether the row was
   * deleted or merely orphaned, which is the exact distinction under test. */
  const rawImageRows = async (db: Database, imageId: string) =>
    await getDb(db).select().from(image).where(eq(image.id, imageId));

  const liveJoinRows = async (db: Database, imageId: string) =>
    await getDb(db)
      .select()
      .from(productImage)
      .where(eq(productImage.imageId, imageId));

  it("re-attaching after a detach uploads again instead of replaying the dead row", async () => {
    const caller = makeCaller();
    const productCode = await createProduct(caller, "Cycle Widget");

    const first = await attach(caller, productCode, "k1", "cover.png");
    expect(first.reused).toBe(false);
    const firstImageId = first.imageId as string;

    // A returned imageId is what the broken version produced too — the join row
    // and the count are what actually prove the file landed.
    expect(await liveJoinRows(ctx.db, firstImageId)).toHaveLength(1);
    expect(await imageCountOf(caller, productCode)).toBe(1);

    const [storedImage] = await rawImageRows(ctx.db, firstImageId);
    const storedKey = storedImage?.key;
    expect(storedKey).toBeTruthy();

    const removed = await callTool(
      "update_product",
      { id: productCode, removeImageIds: [firstImageId] },
      caller,
    );
    expectOk(removed);

    // The row is GONE, not orphaned — this is the assertion the bug failed.
    expect(await rawImageRows(ctx.db, firstImageId)).toHaveLength(0);
    expect(await liveJoinRows(ctx.db, firstImageId)).toHaveLength(0);
    expect(await imageCountOf(caller, productCode)).toBe(0);
    expect(vi.mocked(deleteS3Object)).toHaveBeenCalledWith(storedKey);

    // The same key again. Previously this returned the detached row with a
    // success payload and attached nothing.
    const second = await attach(caller, productCode, "k1", "cover-again.png");
    expect(second.reused).toBe(false);
    expect(second.imageId).not.toBe(firstImageId);
    expect(await liveJoinRows(ctx.db, second.imageId as string)).toHaveLength(
      1,
    );
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

  it("keeps a file that another entity still references", async () => {
    const caller = makeCaller();
    const productA = await createProduct(caller, "Shared Widget A");
    const productB = await createProduct(caller, "Shared Widget B");

    const attached = await attach(caller, productA, "k3", "shared.png");
    const imageId = attached.imageId as string;

    // Reuse the one Image row on a second product, the way the gallery's
    // pendingImageIds path does.
    await getDb(ctx.db)
      .insert(productImage)
      .values({
        productId: (await getDb(ctx.db).query.product.findFirst({
          where: (p, { eq: e }) => e(p.shortcode, productB),
        }))!.id,
        imageId,
        sortOrder: 0,
      });

    const removed = await callTool(
      "update_product",
      { id: productA, removeImageIds: [imageId] },
      caller,
    );
    expectOk(removed);

    // Detached from A, but B still points at it — the bytes must survive.
    expect(await rawImageRows(ctx.db, imageId)).toHaveLength(1);
    expect(await imageCountOf(caller, productA)).toBe(0);
    expect(await imageCountOf(caller, productB)).toBe(1);
  });
});
