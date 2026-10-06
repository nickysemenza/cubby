import { gatewayResponseInfo } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { GatewayCallOptions } from "~/server/ai/gateway";
import { type AiUsagePort, recordAiUsage } from "~/server/ai/usage";
import { Database } from "~/server/db";

import { auditPurchaseImportBatch, type PurchaseAuditPorts } from "./extract";

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

  // Regression: recovery dropped Anthropic's prompt-cache token classes and
  // the gateway log id, and priced a gateway cache HIT as a fresh call.
  it("records prompt-cache tokens, the gateway log id, and a free gateway hit", async () => {
    const emit = vi.fn<AiUsagePort["emit"]>();
    const ports = fromPartial<PurchaseAuditPorts>({
      runStructured: vi.fn(async () => {
        throw new Error("primary schema rejected");
      }),
      // Reports the response as the real transport does, body untouched.
      gateway: (_provider: string, call: GatewayCallOptions) => async () => {
        call.onTransport?.("gateway");
        const response = new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 4,
            },
          }),
          {
            status: 200,
            headers: {
              "cf-aig-log-id": "log-recovery",
              "cf-aig-cache-status": "HIT",
            },
          },
        );
        call.onResponse?.(gatewayResponseInfo(response));
        return response;
      },
      usage: (
        database: Parameters<PurchaseAuditPorts["usage"]>[0],
        input: Parameters<PurchaseAuditPorts["usage"]>[1],
      ) => recordAiUsage(database, input, { emit }),
    });
    const db = new Database(() => {
      throw new Error(
        "Audit recovery unit test never resolves a database runtime",
      );
    });

    await auditPurchaseImportBatch(
      {
        db,
        runId: "00000000-0000-4000-8000-000000000001",
        renderedBatch: [],
      },
      ports,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      feature: "purchase-import-audit",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 4,
      gatewayLogId: "log-recovery",
      transport: "gateway",
      estimatedCost: 0,
    });
  });
});
