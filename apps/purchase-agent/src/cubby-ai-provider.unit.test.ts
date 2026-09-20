import { describe, expect, it, vi } from "vitest";

import { createCubbyGatewayFetch } from "./cubby-ai-provider";

describe("createCubbyGatewayFetch", () => {
  it("routes OpenAI Responses through the Cubby Universal Gateway", async () => {
    const expected = new Response("stream", { status: 200 });
    const run = vi.fn(async () => expected);
    const gatewayFetch = createCubbyGatewayFetch(() => ({ run }));

    const response = await gatewayFetch(
      "https://ai-gateway.invalid/openai/responses?beta=true",
      {
        method: "POST",
        headers: {
          authorization: "Bearer placeholder",
          "content-length": "42",
          "content-type": "application/json",
          "x-api-key": "placeholder",
          "x-client-request-id": "run-1",
        },
        body: JSON.stringify({ model: "gpt-5.6-luna", stream: true }),
      },
    );

    expect(response).toBe(expected);
    expect(run).toHaveBeenCalledWith(
      {
        provider: "openai",
        endpoint: "responses?beta=true",
        headers: {
          "content-type": "application/json",
          "x-client-request-id": "run-1",
        },
        query: { model: "gpt-5.6-luna", stream: true },
      },
      {
        gateway: {
          id: "cubby",
          metadata: { jobKind: "purchase_import_run" },
        },
        signal: undefined,
      },
    );
  });
});
