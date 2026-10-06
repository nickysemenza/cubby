import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import {
  expense,
  product,
  purchase,
  run as runTable,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import {
  importOrderHistory,
  purchasesForOrder,
} from "~/server/purchase-import/order-import.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "./mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

/**
 * An MCP client starts an enrichment run for an import-created Product and
 * polls it. Failure modes: the start actions are not exposed; the launch
 * preview hides the source a start needs; the start answers a uuid instead of
 * the RUN- code `entity_read` takes, or the preview leaks a uuid account id;
 * the MCP context lacks the member party;
 * a repeated start opens a second run on the same account instead of naming
 * the run that blocks it.
 */
describe("run start through MCP", () => {
  const ctx = withTestDb("mcp");
  const sent: PurchaseAgentEvent[] = [];

  beforeEach(() => {
    sent.length = 0;
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (event: PurchaseAgentEvent) => {
            sent.push(event);
          },
        },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  const call = async (tool: string, args: ToolArguments) => {
    const requestContext = requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const response = await callMcpTool(
      createMcpServer(),
      tool,
      args,
      requestContext,
      { entityKernel: entityKernelContextSchema.parse(requestContext) },
    );
    if (response.isError)
      throw new Error(
        `${tool}.${String(args.action)}: ${JSON.stringify(response.content)}`,
      );
    return response.structuredContent;
  };

  const importProduct = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic enrichment member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Garden Supply",
      website: "https://shop.example.test/",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic garden account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    await importOrderHistory(ctx.db, ctx.actor, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      orderId: "EX-SYN-7001",
      orderedAt: "2026-09-01T12:00:00.000Z",
      lines: [{ title: "Synthetic hand trowel", amount: 12 }],
      revision: "a",
    });
    // The import run itself holds the account until it finishes.
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed" })
      .where(eq(runTable.vendorAccountId, account.id));
    const [order] = await purchasesForOrder(ctx.db, "EX-SYN-7001");
    const [line] = await getDb(ctx.db)
      .select({ productId: product.shortcode })
      .from(expense)
      .innerJoin(product, eq(product.id, expense.productId))
      .where(eq(expense.purchaseId, order!.id));
    return { productId: line!.productId, order: order! };
  };

  it("starts a product_enrichment run, reads it back, and names it when started again", async () => {
    const { productId } = await importProduct();

    const preview = z
      .object({
        products: z.array(
          z.object({
            productId: z.string(),
            sourceId: z.string(),
            vendorAccountId: z.string(),
          }),
        ),
      })
      .parse(
        await call("imports_read", {
          action: "run_launch_preview",
          purpose: "product_enrichment",
          targetId: productId,
        }),
      );
    const [target] = preview.products;
    // The account is a public code, never the uuid behind it.
    expect(target!.vendorAccountId).toMatch(/^VACCT-/);
    const start = () =>
      call("run", {
        action: "start",
        purpose: "product_enrichment",
        targets: [{ productId, sourceId: target!.sourceId }],
      });

    const first = await start();
    expect(first).toMatchObject({
      runs: [
        {
          created: true,
          run: { id: expect.stringMatching(/^RUN-/), status: "running" },
          blockingRun: null,
        },
      ],
    });
    const runId = z
      .object({
        runs: z.tuple([z.object({ run: z.object({ id: z.string() }) })]),
      })
      .parse(first).runs[0].run.id;
    expect(sent).toHaveLength(1);

    expect(
      await call("entity_read", {
        action: "get",
        entity: "run",
        id: runId,
        resultDetail: "full",
      }),
    ).toMatchObject({
      item: { id: runId, purpose: "product_enrichment", status: "running" },
    });

    expect(await start()).toEqual({
      runs: [
        {
          created: false,
          run: null,
          blockingRun: { id: runId, status: "running" },
        },
      ],
    });
    expect(sent).toHaveLength(1);
  });

  // With no account there is no account lock to block on, so a retried start
  // (say, after a lost MCP response) must find the active run by its target.
  it("names the active run when an accountless purchase_validation start is repeated", async () => {
    const { order } = await importProduct();
    await getDb(ctx.db)
      .update(purchase)
      .set({ vendorAccountId: null })
      .where(eq(purchase.id, order.id));
    const start = () =>
      call("run", {
        action: "start",
        purpose: "purchase_validation",
        purchaseId: order.shortcode,
        sourceId: null,
      });

    const first = z
      .object({
        runs: z.tuple([
          z.object({
            created: z.literal(true),
            run: z.object({ id: z.string() }),
          }),
        ]),
      })
      .parse(await start());
    expect(await start()).toEqual({
      runs: [
        {
          created: false,
          run: null,
          blockingRun: { id: first.runs[0].run.id, status: "running" },
        },
      ],
    });
    expect(sent).toHaveLength(1);
  });
});
