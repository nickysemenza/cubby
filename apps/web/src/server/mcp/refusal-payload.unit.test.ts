import { toPublicImpact } from "@cubby/schemas/entity-integrity";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  createTestTRPCContext,
  createTRPCRouter,
  protectedProcedure,
} from "~/server/api/trpc";
import { handleTRPCFetchRequest } from "~/server/api/trpc-fetch-handler";
import type { Database } from "~/server/db";
import {
  createAppError,
  createBlockedError,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { createMcpServer } from "./server";
import { ERROR_META_KEY } from "./tools/_shared";

/**
 * A refusal has to survive BOTH transports with the same structure.
 *
 * The MCP half is the one that used to lose it: `registerMcpTool`'s catch
 * rendered every throw to a sentence, so `delete_entity`'s promise of a typed
 * reason and blocker ids was true over tRPC and false over MCP. These pin the
 * two shapes that fixed it — a blocked operation as a NON-error result inside
 * the declared output schema, a genuine fault as `isError` plus `_meta` — and
 * the property that both transports read the same whitelist.
 *
 * The MCP calls go through the real SDK `Client`, which validates
 * `structuredContent` against the advertised output schema. That is the whole
 * reason the refusal lives in the schema rather than in `structuredContent` on
 * an errored result: the reference client rejects the latter outright.
 */

const BLOCKED_PRODUCT = "PRD-4K7M";
const BLOCKER_TARGET_UUID = "00000000-0000-0000-0000-000000000001";

const inventoryBlocker = toPublicImpact(
  {
    code: "block-live-inventory",
    effect: "block",
    label: "inventory entries",
    description: "Live inventory still references this product.",
    total: 2,
    byTargetId: { [BLOCKER_TARGET_UUID]: 2 },
  },
  new Map([[BLOCKER_TARGET_UUID, BLOCKED_PRODUCT]]),
  "drop",
);

const blockedDelete = () =>
  createBlockedError(
    "PRODUCT_HAS_INVENTORY",
    "Cannot delete a product while inventory references it.",
    [inventoryBlocker],
  );

/**
 * Call a registered tool over a real client/server transport pair, injecting a
 * stub tRPC caller through the same `authInfo.extra.caller` channel production
 * auth uses.
 */
async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: stub tRPC caller for tool tests
  caller: any,
) {
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
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("a blocked delete comes back as an answer, not an error", () => {
  it("returns isError: false with the blockers inside the declared output schema", async () => {
    const remove = vi.fn().mockRejectedValue(blockedDelete());

    const result = await callTool(
      createMcpServer(),
      "delete_entity",
      { entity: "product", ids: [BLOCKED_PRODUCT] },
      { product: { delete: remove } },
    );

    // Not an error envelope: the guard ran and has something to say.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      deleted: 0,
      refusal: {
        code: "PRECONDITION_FAILED",
        reason: "PRODUCT_HAS_INVENTORY",
        blockers: [
          {
            code: "block-live-inventory",
            effect: "block",
            total: 2,
            // Keyed by shortcode — the structure the sentence used to swallow.
            byTargetId: { [BLOCKED_PRODUCT]: 2 },
          },
        ],
      },
    });
    expect(remove).toHaveBeenCalledWith({ ids: [BLOCKED_PRODUCT] });
  });

  it("omits `refusal` entirely when the delete ran", async () => {
    const result = await callTool(
      createMcpServer(),
      "delete_entity",
      { entity: "product", ids: [BLOCKED_PRODUCT] },
      { product: { delete: vi.fn().mockResolvedValue({ deleted: 1 }) } },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      deleted: 1,
      sideEffects: [],
    });
  });
});

describe("a genuine fault stays an error, and says why in _meta", () => {
  it("carries code and reason for a wrong-prefix shortcode", async () => {
    const remove = vi.fn();

    const result = await callTool(
      createMcpServer(),
      "delete_entity",
      // A PRD- code under entity=location: refused on the prefix, and never
      // routed to the wrong table.
      { entity: "location", ids: [BLOCKED_PRODUCT] },
      { location: { delete: remove } },
    );

    expect(result.isError).toBe(true);
    expect(result._meta?.[ERROR_META_KEY]).toEqual({
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("carries code and reason for a failure raised by the router", async () => {
    const result = await callTool(
      createMcpServer(),
      "delete_entity",
      { entity: "product", ids: [BLOCKED_PRODUCT] },
      {
        product: {
          delete: vi
            .fn()
            .mockRejectedValue(createAppError("PRODUCT_NOT_FOUND", "gone")),
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result._meta?.[ERROR_META_KEY]).toEqual({
      code: "NOT_FOUND",
      reason: "PRODUCT_NOT_FOUND",
    });
  });
});

describe("a refused merge cluster names its blockers too", () => {
  it("keeps the batch successful and puts the refusal on the cluster", async () => {
    const result = await callTool(
      createMcpServer(),
      "merge_entity",
      {
        entity: "product",
        merges: [{ keepId: BLOCKED_PRODUCT, mergeIds: ["PRD-9Z2Q"] }],
      },
      { product: { merge: vi.fn().mockRejectedValue(blockedDelete()) } },
    );

    // A wholly-failed batch is still `isError: false` — the per-cluster
    // refusals are the payload, and the same four fields a refused delete
    // nests are flattened onto the cluster here.
    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { results: unknown[] }).results,
    ).toMatchObject([
      {
        keepId: BLOCKED_PRODUCT,
        status: "failed",
        code: "PRECONDITION_FAILED",
        reason: "PRODUCT_HAS_INVENTORY",
        blockers: [{ code: "block-live-inventory", total: 2 }],
      },
    ]);
  });
});

describe("one whitelist, not two", () => {
  it("yields the same {code, reason, blockers} through tRPC and through MCP", async () => {
    const error = blockedDelete();
    const expected = toPublicErrorPayload(error);

    // tRPC: the formatter lifts it onto `shape.data` over a real HTTP request.
    const router = createTRPCRouter({
      refuse: protectedProcedure.query(() => {
        throw error;
      }),
    });
    const response = await handleTRPCFetchRequest({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/refuse"),
      router,
      createContext: () =>
        Promise.resolve(
          createTestTRPCContext({} as Database, {
            auth: { userId: unsafeUserId("test-user-id") },
          }),
        ),
    });
    const body = (await response.json()) as {
      error: { json: { data: Record<string, unknown> } };
    };
    const trpcData = body.error.json.data;

    // MCP: the same failure, through the generic delete tool.
    const mcp = await callTool(
      createMcpServer(),
      "delete_entity",
      { entity: "product", ids: [BLOCKED_PRODUCT] },
      { product: { delete: vi.fn().mockRejectedValue(error) } },
    );
    const refusal = (
      mcp.structuredContent as {
        refusal: { code: string; reason: string; blockers: unknown[] };
      }
    ).refusal;

    expect({
      code: trpcData.code,
      reason: trpcData.reason,
      blockers: trpcData.blockers,
    }).toEqual(expected);
    expect({
      code: refusal.code,
      reason: refusal.reason,
      blockers: refusal.blockers,
    }).toEqual(expected);
  });
});
