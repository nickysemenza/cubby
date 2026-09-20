import type { FlueEvent } from "@flue/runtime";
import { describe, expect, it } from "vitest";

import { usageEventForTurn } from "./telemetry";

describe("purchase-agent turn telemetry", () => {
  it("records one provider/model attempt without an aggregate charge", () => {
    // SAFETY: this fixture supplies the complete observable turn-event shape
    // consumed by usageEventForTurn; Flue's wider event union is irrelevant.
    const event = {
      type: "turn",
      v: 3,
      eventIndex: 9,
      timestamp: "2026-09-20T19:00:00.000Z",
      instanceId: "import-run:f47ac10b-58cc-4372-a567-0e02b2c3d479",
      submissionId: "submission-7",
      turnId: "turn-3",
      purpose: "agent",
      durationMs: 1_250,
      request: {
        providerId: "anthropic",
        providerName: "Anthropic through Cubby AI Gateway",
        requestedModel: "claude-sonnet-5",
        api: "anthropic-messages",
      },
      response: {
        gatewayLogId: "gateway-log-4",
        usage: {
          input: 100,
          output: 25,
          cacheRead: 50,
          cacheWrite: 10,
          totalTokens: 185,
          cost: {
            input: 0.0002,
            output: 0.00025,
            cacheRead: 0.00001,
            cacheWrite: 0.000025,
            total: 0.000485,
          },
        },
      },
      isError: false,
    } as FlueEvent & { type: "turn" };

    expect(
      usageEventForTurn("f47ac10b-58cc-4372-a567-0e02b2c3d479", event, 2),
    ).toEqual({
      runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      eventId: "model-turn:submission-7:2:turn-3",
      provider: "anthropic",
      model: "claude-sonnet-5",
      feature: "purchase_import_agent",
      operation: "flue.agent",
      attempt: 2,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      durationMs: 1_250,
      status: "succeeded",
      gatewayLogId: "gateway-log-4",
      estimatedCost: 0.000485,
    });
  });
});
