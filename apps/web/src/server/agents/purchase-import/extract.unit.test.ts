import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

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
      gateway: () => gatewayRequest,
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
      }),
    );
  });
});
