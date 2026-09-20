import { describe, expect, it } from "vitest";

import {
  purchaseAgentRequestIsWritable,
  redactAgentEventLine,
} from "./agent-proxy";

describe("purchase-agent proxy mutation fence", () => {
  it("allows the fenced abort to reach Flue while keeping other terminal writes view-only", () => {
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
