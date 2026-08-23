/**
 * The attach → detach → re-attach cycles driven through the real MCP server
 * against a real Postgres — both kinds.
 *
 * `attach_entity` / `detach_entity` (the RELATION edges: kit components,
 * project resource uses, purchase provenance links) are exercised at the
 * bottom; `attach_file` (bytes into R2) is exercised above. They share this file
 * because they share the property being tested — that the tool's RESPONSE tells
 * the truth about what the write did.
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

/**
 * The machine-readable half of a FAULT. Rides in `_meta`, not
 * `structuredContent`, because the reference SDK client validates
 * `structuredContent` against the declared output schema with no exemption for
 * `isError` — see `structuredError` in tools/_shared.ts.
 */
function errorMeta(result: CallToolResult): Record<string, unknown> {
  return (result._meta?.["cubby/error"] ?? {}) as Record<string, unknown>;
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

/**
 * The three relation families through the two generic tools.
 *
 * These assert on `cause.reason` / the structured `refusal`, never on message
 * text: the whole point of collapsing six tools into two was that a caller can
 * still branch on WHY without substring-matching a sentence, and a test that
 * matches prose would pass while that property was broken.
 */
describe("attach_entity / detach_entity", () => {
  const ctx = withTestDb("mcp");
  const makeCaller = () => createTestCaller(domainRouter, ctx.db);

  const createProductWith = async (
    caller: DomainCaller,
    name: string,
    category?: string,
  ) => {
    const created = await callTool(
      "create_product",
      {
        name,
        manufacturer: "Test Mfg",
        upc: null,
        ingredientId: null,
        ...(category ? { category } : {}),
      },
      caller,
    );
    expectOk(created);
    return structured(created).id as string;
  };

  const createProjectCode = async (caller: DomainCaller, name: string) => {
    const created = await callTool("create_project", { name }, caller);
    expectOk(created);
    return structured(created).id as string;
  };

  it("attaches kit components with quantity, and is idempotent", async () => {
    const caller = makeCaller();
    const kit = await createProductWith(caller, "Generic Kit");
    const partA = await createProductWith(caller, "Generic Part A");
    const partB = await createProductWith(caller, "Generic Part B");

    const attached = await callTool(
      "attach_entity",
      {
        parentId: kit,
        items: [
          { productId: partA, quantity: 4 },
          // Omitted quantity is the 1-per-kit default, not a rejection.
          { productId: partB },
        ],
      },
      caller,
    );
    expectOk(attached);
    expect(structured(attached)).toMatchObject({
      changed: 2,
      attached: 2,
      alreadySatisfied: 0,
    });

    const again = await callTool(
      "attach_entity",
      { parentId: kit, items: [{ productId: partA, quantity: 4 }] },
      caller,
    );
    expectOk(again);
    expect(structured(again)).toMatchObject({
      changed: 0,
      attached: 2,
      alreadySatisfied: 1,
    });

    const detached = await callTool(
      "detach_entity",
      { parentId: kit, productIds: [partA, partB] },
      caller,
    );
    expectOk(detached);
    expect(structured(detached)).toMatchObject({
      changed: 2,
      attached: 0,
      alreadySatisfied: 0,
    });

    // Detaching what is already gone is a no-op, never an error.
    const detachedAgain = await callTool(
      "detach_entity",
      { parentId: kit, productIds: [partA] },
      caller,
    );
    expectOk(detachedAgain);
    expect(structured(detachedAgain)).toMatchObject({
      changed: 0,
      alreadySatisfied: 1,
    });
  });

  it("dispatches on the parent prefix: PRJ- records a project use", async () => {
    const caller = makeCaller();
    const project = await createProjectCode(caller, "Relation Project");
    const tool = await createProductWith(caller, "Relation Drill", "tools");

    const attached = await callTool(
      "attach_entity",
      { parentId: project, items: [{ productId: tool }] },
      caller,
    );
    expectOk(attached);
    expect(structured(attached)).toMatchObject({ changed: 1, attached: 1 });

    const listed = await callTool(
      "list_project_resources",
      { projectId: project },
      caller,
    );
    expectOk(listed);
    expect(JSON.stringify(structured(listed))).toContain(tool);
  });

  /**
   * The cost of the collapse, asserted.
   *
   * Three input schemas became one, so `quantity` now EXISTS on a call whose
   * relation carries none. It is refused rather than ignored — a silently
   * dropped quantity is exactly the failure the trade makes possible.
   */
  it("REFUSES quantity on a parent whose relation carries none", async () => {
    const caller = makeCaller();
    const project = await createProjectCode(caller, "Quantity Project");
    const tool = await createProductWith(caller, "Quantity Drill", "tools");

    const result = await callTool(
      "attach_entity",
      { parentId: project, items: [{ productId: tool, quantity: 3 }] },
      caller,
    );
    expect(result.isError).toBe(true);
    expect(errorMeta(result)).toMatchObject({
      reason: "RELATION_QUANTITY_UNSUPPORTED",
    });
    // And nothing was written.
    const listed = await callTool(
      "list_project_resources",
      { projectId: project },
      caller,
    );
    expectOk(listed);
    expect(structured(listed).items).toEqual([]);
  });

  /**
   * The B2 defect, end to end: a live product of the wrong category used to come
   * back as PRODUCT_NOT_FOUND with no ids at all.
   */
  it("refuses a wrong-category project resource and NAMES the id", async () => {
    const caller = makeCaller();
    const project = await createProjectCode(caller, "Category Project");
    const lumber = await createProductWith(
      caller,
      "Category Lumber",
      "hardware",
    );

    const result = await callTool(
      "attach_entity",
      { parentId: project, items: [{ productId: lumber }] },
      caller,
    );
    // A refusal is a domain ANSWER, inside the declared output schema — not an
    // `isError` envelope, which carries prose and nothing a client may rely on.
    expectOk(result);
    const body = structured(result);
    expect(body.changed).toBe(0);
    const refusal = body.refusal as {
      reason?: string;
      blockers?: Array<{ code: string; byTargetId: Record<string, number> }>;
    };
    expect(refusal.reason).toBe("PRODUCT_CATEGORY_INELIGIBLE");
    expect(refusal.blockers?.map((b) => b.code)).toContain(
      "block-product-category-ineligible",
    );
    // The half that used to be computed and discarded: WHICH id blocked.
    expect(
      refusal.blockers?.flatMap((b) => Object.keys(b.byTargetId)),
    ).toContain(lumber);
  });

  it("previews an attach without committing it", async () => {
    const caller = makeCaller();
    const project = await createProjectCode(caller, "Preview Project");
    const lumber = await createProductWith(
      caller,
      "Preview Lumber",
      "hardware",
    );

    const preview = await callTool(
      "preview_entity_operation",
      {
        operation: "attach",
        entity: "project",
        parentId: project,
        productIds: [lumber],
      },
      caller,
    );
    expectOk(preview);
    const body = structured(preview) as {
      canProceed: boolean;
      blockers: Array<{ code: string; byTargetId: Record<string, number> }>;
    };
    expect(body.canProceed).toBe(false);
    expect(body.blockers.map((b) => b.code)).toContain(
      "block-product-category-ineligible",
    );
    expect(body.blockers.flatMap((b) => Object.keys(b.byTargetId))).toContain(
      lumber,
    );
    // Advisory only — the preview wrote nothing.
    const listed = await callTool(
      "list_project_resources",
      { projectId: project },
      caller,
    );
    expectOk(listed);
    expect(structured(listed).items).toEqual([]);
  });
});
