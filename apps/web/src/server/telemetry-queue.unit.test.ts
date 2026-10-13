import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { describe, expect, it, vi } from "vitest";

import type { snapshotAiUsagePrice } from "~/server/ai/pricing";
import { Database } from "~/server/db";

import {
  processTelemetryQueueBatch,
  type TelemetryQueuePorts,
} from "./telemetry-queue";

const db = new Database(() => {
  throw new Error(
    "Telemetry-queue unit ports do not resolve a database runtime",
  );
});
const event: TelemetryMessageV1 = {
  version: 1,
  queueType: "telemetry",
  eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
  occurredAt: "2026-08-02T16:00:00.000Z",
  release: "abcdef0",
  type: "mcp_tool_call",
  toolName: "search_products",
  outcome: "success",
  registeredAtCall: true,
  surface: "external_mcp",
  userId: "user_1",
  clientId: null,
};

const legacyAiEvent = {
  version: 1 as const,
  queueType: "telemetry" as const,
  eventId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-01-01T00:00:00Z",
  release: "synthetic",
  type: "ai_usage" as const,
  feature: "synthetic",
  provider: "openai",
  model: "gpt-6-sol",
  operation: "synthetic",
  transport: "gateway" as const,
  inputTokens: 1000,
  outputTokens: 1000,
  durationMs: 1,
  cacheStatus: "hit" as const,
  entityKind: null,
  entityId: null,
};

describe("processTelemetryQueueBatch", () => {
  it("acknowledges a persisted valid message", async () => {
    let acknowledged = false;
    const ports = {
      persistTelemetryMessages: async () => undefined,
    } satisfies TelemetryQueuePorts;
    await processTelemetryQueueBatch(
      db,
      {
        queue: "cubby-telemetry",
        messages: [
          {
            body: event,
            ack: () => {
              acknowledged = true;
            },
            retry: () => undefined,
          },
        ],
      },
      ports,
    );
    expect(acknowledged).toBe(true);
  });
});

it("reconstructs only the legacy token-only billed message before persistence", async () => {
  const legacy = legacyAiEvent;
  const current = {
    ...legacy,
    eventId: "00000000-0000-4000-8000-000000000002",
    standardCost: null,
    chargedCost: null,
    costEvidence: {
      standard: null,
      charged: null,
      billingReason: "unknown" as const,
      original: { estimatedCost: null },
    },
  };
  const snapshot = vi
    .fn<typeof snapshotAiUsagePrice>()
    .mockResolvedValue({
      amount: 0.003,
      evidence: {
        source: "estimate",
        pricingSource: "models.dev",
        pricingSnapshot: {
          provider: "openai",
          model: "gpt-6-sol",
          capturedAt: "2026-01-01T00:00:00Z",
          rates: { input: 1, output: 2 },
        },
      },
    });
  const persisted: TelemetryMessageV1[] = [];
  await processTelemetryQueueBatch(
    db,
    {
      queue: "cubby-telemetry",
      messages: [legacy, current].map((body) => ({
        body,
        ack: () => undefined,
        retry: () => undefined,
      })),
    },
    {
      snapshot,
      persistTelemetryMessages: async (_db, messages) => {
        persisted.push(...messages);
      },
    },
  );
  expect(persisted[0]).toMatchObject({
    standardCost: 0.003,
    chargedCost: 0.003,
    costEvidence: {
      standard: { source: "reconstructed", pricingSource: "models.dev" },
      charged: { source: "reconstructed", pricingSource: "models.dev" },
      original: { estimatedCost: null },
    },
  });
  expect(persisted[1]).toEqual(current);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(snapshot).toHaveBeenCalledWith("openai", "gpt-6-sol", legacy, {
    requireCatalog: true,
  });
});

it("preserves numeric legacy figures and keeps unsupported or inconsistent billed usage unknown", async () => {
  const snapshot = vi
    .fn<typeof snapshotAiUsagePrice>()
    .mockResolvedValue({
      amount: 0.003,
      evidence: {
        source: "estimate",
        pricingSource: "models.dev",
        pricingSnapshot: {
          provider: "openai",
          model: "gpt-6-sol",
          capturedAt: "2026-01-01T00:00:00Z",
          rates: { input: 1, output: 2 },
        },
      },
    });
  const bodies = [
    { ...legacyAiEvent, transport: "direct", estimatedCost: 0.007 },
    { ...legacyAiEvent, transport: "chatgpt", estimatedCost: 0.009 },
    { ...legacyAiEvent, transport: "cache", estimatedCost: -0.004 },
    { ...legacyAiEvent, transport: "chatgpt" },
    { ...legacyAiEvent, transport: "cache" },
    { ...legacyAiEvent, inputTokens: 0, outputTokens: 0 },
    { ...legacyAiEvent, transport: "unknown" },
    { ...legacyAiEvent, applicationCacheStatus: "hit" },
    { ...legacyAiEvent, attempt: 0 },
  ];
  const persisted: TelemetryMessageV1[] = [];
  await processTelemetryQueueBatch(
    db,
    {
      queue: "cubby-telemetry",
      messages: bodies.map((body) => ({
        body: { ...body, eventId: crypto.randomUUID() },
        ack: () => undefined,
        retry: () => undefined,
      })),
    },
    {
      snapshot,
      persistTelemetryMessages: async (_db, messages) => {
        persisted.push(...messages);
      },
    },
  );
  expect(
    persisted.map((row) => {
      if (row.type !== "ai_usage")
        throw new Error("Only synthetic AI messages were queued");
      return [
        row.standardCost,
        row.chargedCost,
        row.costEvidence?.original?.estimatedCost,
      ];
    }),
  ).toEqual([
    [0.003, 0.007, 0.007],
    [0.003, 0.009, 0.009],
    [null, -0.004, -0.004],
    [0.003, 0, null],
    [null, 0, null],
    [null, null, null],
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]);
  expect(
    persisted.map((row) =>
      row.type === "ai_usage" ? row.costEvidence?.billingReason : null,
    ),
  ).toEqual([
    "unknown",
    "plan",
    "cache",
    "plan",
    "cache",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(snapshot).toHaveBeenCalledTimes(3);
});

it("retries the validated batch when legacy pricing preparation rejects", async () => {
  const retry = vi.fn<() => void>();
  const ack = vi.fn<() => void>();
  const persist = vi.fn<TelemetryQueuePorts["persistTelemetryMessages"]>();
  const snapshot = vi
    .fn<typeof snapshotAiUsagePrice>()
    .mockRejectedValue(new Error("Synthetic pricing preparation rejection"));
  await expect(
    processTelemetryQueueBatch(
      db,
      {
        queue: "cubby-telemetry",
        messages: [legacyAiEvent, event].map((body) => ({ body, retry, ack })),
      },
      { snapshot, persistTelemetryMessages: persist },
    ),
  ).rejects.toThrow("Synthetic pricing preparation rejection");
  expect(retry).toHaveBeenCalledTimes(2);
  expect(ack).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});
