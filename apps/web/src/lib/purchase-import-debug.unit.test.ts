import { describe, expect, it } from "vitest";

import {
  purchaseImportDebugEvent,
  importRunLogRequest,
  importRunLogResponse,
} from "./purchase-import-debug";

const validEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-09-19T18:00:00Z",
  event: "command.finished",
  runId: "22222222-2222-4222-8222-222222222222",
  commandId: "33333333-3333-4333-8333-333333333333",
  operationId: "capture-001",
  operationKind: "capture",
  host: "orders.example.test",
  browser: "chrome",
  outcome: "failed:capture_unavailable:retryable=true",
};

describe("purchase import debug contract", () => {
  it("accepts bounded run metadata", () => {
    expect(purchaseImportDebugEvent.parse(validEvent)).toMatchObject(
      validEvent,
    );
  });

  it.each([
    { ...validEvent, runId: undefined },
    { ...validEvent, host: "https://orders.example.test/private/order/1" },
    { ...validEvent, outcome: "page text must never be persisted" },
    { ...validEvent, event: "page.capture.raw" },
  ])("rejects unscoped or unbounded client data", (event) => {
    expect(purchaseImportDebugEvent.safeParse(event).success).toBe(false);
  });

  it("does not expose operation input or result payloads in the web log", () => {
    const parsed = importRunLogResponse.parse({
      entries: [
        {
          id: "event-1",
          occurredAt: "2026-09-19T18:00:00Z",
          source: "server",
          level: "info",
          event: "tool.capture",
          state: "completed",
          commandId: null,
          operationId: "capture-001",
          operationKind: null,
          host: null,
          browser: null,
          attempt: null,
          count: null,
          outcome: null,
          messageType: null,
          errorType: null,
          errorCode: null,
          error: null,
          result: { pageText: "private" },
        },
      ],
      truncated: false,
    });

    expect(parsed.entries[0]).not.toHaveProperty("result");
  });

  it("accepts the public PIR address used by the detail page", () => {
    expect(importRunLogRequest.parse({ publicId: "RUN-4K7M" })).toEqual({
      publicId: "RUN-4K7M",
    });
    expect(
      importRunLogRequest.safeParse({ publicId: validEvent.runId }).success,
    ).toBe(false);
  });
});
