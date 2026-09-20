import { createFlueClient } from "@flue/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { productReuseFixture } from "./fixtures/product-reuse";

type EvalResult = {
  toolCalls: Array<{ name: string; runOperationId?: string }>;
  products: Array<{ id: string; name: string }>;
  purchases: Array<{
    id: string;
    productId: string;
    externalOrderId: string;
  }>;
  commitResults: Array<{
    operationId: string;
    outcome: string;
    purchaseId: string;
  }>;
  finalStatus: string;
};

const evalResultSchema: z.ZodType<EvalResult> = z.object({
  toolCalls: z.array(
    z.object({ name: z.string(), runOperationId: z.string().optional() }),
  ),
  products: z.array(z.object({ id: z.string(), name: z.string() })),
  purchases: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      externalOrderId: z.string(),
    }),
  ),
  commitResults: z.array(
    z.object({
      operationId: z.string(),
      outcome: z.string(),
      purchaseId: z.string(),
    }),
  ),
  finalStatus: z.string(),
});

const PROHIBITED_CALLS = new Set([
  "sql",
  "shell",
  "browser_eval",
  "mcp__cubby__entity_mutate",
  "mcp__cubby__entity_delete",
]);

async function evalResult(): Promise<EvalResult> {
  if (process.env.PURCHASE_AGENT_EVAL_LIVE !== "1") {
    return productReuseFixture.result;
  }
  const agentUrl = process.env.PURCHASE_AGENT_EVAL_AGENT_URL;
  const resultUrl = process.env.PURCHASE_AGENT_EVAL_RESULT_URL;
  const sessionCookie = process.env.PURCHASE_AGENT_EVAL_SESSION_COOKIE;
  if (!agentUrl || !resultUrl || !sessionCookie) {
    throw new Error(
      "Live eval requires PURCHASE_AGENT_EVAL_AGENT_URL, PURCHASE_AGENT_EVAL_RESULT_URL, and PURCHASE_AGENT_EVAL_SESSION_COOKIE",
    );
  }
  const conversation = createFlueClient({
    url: agentUrl,
    headers: { cookie: sessionCookie },
  });
  const admission = await conversation.send({
    message: {
      kind: "user",
      body:
        process.env.PURCHASE_AGENT_EVAL_PROMPT ??
        "Process the assigned deterministic import fixture through audited completion.",
    },
  });
  await conversation.wait(admission);

  const response = await fetch(resultUrl, {
    headers: { cookie: sessionCookie },
  });
  if (!response.ok) {
    throw new Error(`Live eval fixture failed with HTTP ${response.status}`);
  }
  return evalResultSchema.parse(await response.json());
}

describe("purchase-import Product reuse fixture", () => {
  it("reuses the Product, reaches the final state, and replays the commit", async () => {
    const result = await evalResult();
    const expected = productReuseFixture.expected;

    expect(
      result.toolCalls.filter((call) => PROHIBITED_CALLS.has(call.name)),
    ).toEqual([]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.id).toBe(expected.reusedProductId);
    expect(result.purchases).toContainEqual(
      expect.objectContaining({
        id: expected.purchaseId,
        productId: expected.reusedProductId,
      }),
    );
    expect(result.finalStatus).toBe(expected.finalStatus);

    const [first, replay] = result.commitResults;
    expect(first).toMatchObject({
      operationId: "commit:order:vendor-1001",
      outcome: "created",
      purchaseId: expected.purchaseId,
    });
    expect(replay).toMatchObject({
      operationId: first?.operationId,
      outcome: "replayed",
      purchaseId: first?.purchaseId,
    });
  });
});
