import { describe, expect, it } from "vitest";

import {
  purchaseAgentRequestIsWritable,
  createPurchaseAgentRequest,
  redactAgentEventLine,
} from "./agent-proxy";

describe("purchase-agent proxy mutation fence", () => {
  it("propagates caller cancellation while stripping credentials from the internal request", () => {
    const abort = new AbortController();
    const internal = createPurchaseAgentRequest(
      new Request("https://example.invalid/agent/stream?cursor=synthetic", {
        headers: {
          authorization: "Bearer synthetic-token",
          cookie: "synthetic-cookie",
          host: "example.invalid",
        },
        signal: abort.signal,
      }),
      "stream",
    );
    expect(internal.url).toBe(
      "https://purchase-agent.internal/stream?cursor=synthetic",
    );
    expect(internal.headers.has("authorization")).toBe(false);
    expect(internal.headers.has("cookie")).toBe(false);
    expect(internal.headers.has("host")).toBe(false);
    abort.abort();
    expect(internal.signal.aborted).toBe(true);
  });

  it("allows the fenced abort to reach the agent while keeping other terminal writes view-only", () => {
    expect(
      purchaseAgentRequestIsWritable({
        method: "POST",
        status: "failed",
        suffix: "abort",
      }),
    ).toBe(true);
    expect(
      purchaseAgentRequestIsWritable({
        method: "POST",
        status: "failed",
        suffix: "",
      }),
    ).toBe(false);
    expect(
      purchaseAgentRequestIsWritable({
        method: "GET",
        status: "completed",
        suffix: "",
      }),
    ).toBe(true);
  });

  it("redacts secrets and binary payloads in live transcript events", () => {
    expect(
      redactAgentEventLine(
        `data: ${JSON.stringify({ token: "reusable", result: { image: `data:image/png;base64,${"A".repeat(5_000)}` } })}`,
      ),
    ).toBe(
      `data: ${JSON.stringify({ token: "[redacted]", result: { image: "[binary omitted]" } })}`,
    );
    expect(redactAgentEventLine("event: message")).toBe("event: message");
    expect(redactAgentEventLine("data: [DONE]")).toBe("data: [DONE]");
  });
});
