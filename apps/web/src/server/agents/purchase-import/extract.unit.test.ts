import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { GatewayCallOptions } from "~/server/clients/ai-gateway";
import { Database } from "~/server/db";

import {
  auditPurchaseImportBatch,
  extractPurchaseOrderMail,
  type PurchaseAuditPorts,
} from "./extract";

describe("purchase import audit recovery", () => {
  it("uses Opus native structured output after the primary audit fails", async () => {
    const runStructured = vi.fn(async () => {
      throw new Error("primary schema rejected");
    });
    const gatewayRequest = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
          { status: 200 },
        ),
    );
    const recordUsage = vi.fn();
    const ports = fromPartial<PurchaseAuditPorts>({
      runStructured,
      gateway:
        (_provider: string, call: GatewayCallOptions) =>
        (url: RequestInfo | URL, init?: RequestInit) => {
          call.onTransport?.("gateway");
          return gatewayRequest(String(url), init);
        },
      usage: recordUsage,
    });
    const db = new Database(() => {
      throw new Error(
        "Audit recovery unit test never resolves a database runtime",
      );
    });

    await expect(
      auditPurchaseImportBatch(
        {
          db,
          runId: "00000000-0000-4000-8000-000000000001",
          renderedBatch: [],
        },
        ports,
      ),
    ).resolves.toEqual({ findings: [] });

    const [url, init] = gatewayRequest.mock.calls[0] ?? [];
    if (!init) throw new Error("Audit recovery did not call the gateway");
    expect(url).toBe("https://ai-gateway.invalid/anthropic/v1/messages");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.stringify(body.output_config.format.schema)).not.toMatch(
      /"oneOf"|"minimum"|"maximum"/,
    );
    expect(recordUsage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-5-5",
        inputTokens: 100,
        outputTokens: 20,
        transport: "gateway",
      }),
    );
  });

  it("records a failed recovery on its transport and rethrows", async () => {
    const recordUsage = vi.fn();
    const ports = fromPartial<PurchaseAuditPorts>({
      runStructured: vi.fn(async () => {
        throw new Error("primary schema rejected");
      }),
      gateway: (_provider: string, call: GatewayCallOptions) => async () => {
        call.onTransport?.("gateway");
        return new Response("overloaded", { status: 529 });
      },
      usage: recordUsage,
    });
    const db = new Database(() => {
      throw new Error(
        "Audit recovery unit test never resolves a database runtime",
      );
    });

    await expect(
      auditPurchaseImportBatch(
        {
          db,
          runId: "00000000-0000-4000-8000-000000000001",
          renderedBatch: [],
        },
        ports,
      ),
    ).rejects.toThrow(/failed on both/);
    expect(recordUsage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        operation: "purchaseImport.audit.recovery",
        status: "failed",
        transport: "gateway",
      }),
    );
  });
});

type MailPorts = NonNullable<Parameters<typeof extractPurchaseOrderMail>[1]>;

describe("order confirmation email extraction", () => {
  const db = new Database(() => {
    throw new Error("Mail extraction unit test never resolves a database");
  });
  const mail = {
    sender: "Example Seeds <orders@seeds.example.test>",
    subject: "Order 1001 confirmed",
    receivedAt: new Date("2026-09-22T06:23:46.000Z"),
    content: { snippet: null, bodyText: "Order 1001", bodyHtml: null },
  };
  const modelOutput = (orderedAt: string | null) => ({
    status: "ready" as const,
    candidate: {
      orderId: "1001",
      orderedAt,
      merchant: "Example Seeds",
      currency: "USD",
      printedGrandTotal: 4.5,
      lines: [
        {
          title: "Tomato seeds",
          amount: 4.5,
          lineKind: "principal" as const,
          quantity: 1,
          productUrl: null,
          imageUrl: null,
          sku: null,
          seller: null,
        },
      ],
      payments: [],
      allShipmentsDelivered: null,
    },
    reason: null,
    detail: null,
  });

  it("dates an undated placement confirmation by when it was sent", async () => {
    const extraction = await extractPurchaseOrderMail(
      {
        db,
        runId: "00000000-0000-4000-8000-000000000001",
        orderId: "1001",
        mail,
      },
      fromPartial<MailPorts>({ runStructured: async () => modelOutput(null) }),
    );
    expect(extraction.candidate?.orderedAt).toBe("2026-09-22T06:23:46.000Z");
  });

  it("keeps an order date the confirmation prints", async () => {
    const extraction = await extractPurchaseOrderMail(
      {
        db,
        runId: "00000000-0000-4000-8000-000000000001",
        orderId: "1001",
        mail,
      },
      fromPartial<MailPorts>({
        runStructured: async () => modelOutput("2026-09-20T12:00:00.000Z"),
      }),
    );
    expect(extraction.candidate?.orderedAt).toBe("2026-09-20T12:00:00.000Z");
  });
});
