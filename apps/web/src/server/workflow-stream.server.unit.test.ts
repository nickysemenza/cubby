import { testUserId } from "@cubby/schemas/testing";
import superjson from "superjson";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Database } from "~/server/db";
import { withErrorReporting } from "~/server/errors/report-error";
import { requireActor } from "~/server/request-context";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { createTestRequestContext } from "~/server/testing/request-context";
import type { AppSpan } from "~/server/tracing";

import {
  type WorkflowStreamRuntime,
  workflowStreamResponse,
} from "./workflow-stream.server";

const database = new Database(() => {
  throw new Error("The workflow stream unit test must not resolve a database");
});
const context = requireActor(
  createTestRequestContext(database, {
    auth: { userId: testUserId("workflow-stream-user") },
  }),
);

const request = () =>
  new Request(
    "https://cubby.test/api/workflow-stream/ai.backfillLocationDescriptions",
    { method: "POST", body: superjson.stringify({}) },
  );

type StreamRun = (
  context: AuthenticatedStartOperationContext,
  input: Record<string, never>,
  signal: AbortSignal,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

const span: AppSpan = {
  isRecording: false,
  setAttribute: () => undefined,
  setAttributes: () => undefined,
  setError: () => undefined,
  recordException: () => undefined,
};
const authenticate = vi.fn<WorkflowStreamRuntime["authenticate"]>();
const recordDatabaseWrite = vi.fn(async () => undefined);
const runtime: WorkflowStreamRuntime = {
  authenticate,
  observe: async (_definition, _observation, run) => await run(span),
  recordDatabaseWrite,
};

const responseFor = (
  operation: "ai.backfillLocationDescriptions",
  run: StreamRun,
) =>
  workflowStreamResponse(
    {
      request: request(),
      operation,
      inputSchema: z.object({}),
      eventSchema: z.object({ n: z.number() }),
      run,
    },
    runtime,
  );

const streamFrameSchema = z.object({
  kind: z.enum(["event", "error"]),
  error: publicStartOperationErrorSchema.optional(),
});

describe("workflow stream freshness notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue(context);
  });

  it("notifies before progress and again during mutation stream finalization", async () => {
    let callsWhenSecondEventStarts = 0;
    const response = await responseFor(
      "ai.backfillLocationDescriptions",
      async function* () {
        yield { n: 1 };
        callsWhenSecondEventStarts = recordDatabaseWrite.mock.calls.length;
        yield { n: 2 };
      },
    );

    await response.text();

    expect(callsWhenSecondEventStarts).toBe(1);
    expect(recordDatabaseWrite).toHaveBeenCalledTimes(3);
    expect(recordDatabaseWrite).toHaveBeenNthCalledWith(
      1,
      "ai.backfillLocationDescriptions",
    );
  });

  it("notifies after a stream that committed progress and then failed", async () => {
    const response = await withErrorReporting(
      () =>
        responseFor("ai.backfillLocationDescriptions", async function* () {
          yield { n: 1 };
          throw new Error("later batch failed");
        }),
      undefined,
      () => "sample-stream-event",
    );

    const frames = (await response.text())
      .trim()
      .split("\n")
      .map((line) => streamFrameSchema.parse(JSON.parse(line)));

    expect(frames.map((frame) => frame.kind)).toEqual(["event", "error"]);
    expect(frames[1]?.error).toMatchObject({
      message: "later batch failed",
      diagnostics: { sentryEventId: "sample-stream-event", stage: "run" },
    });
    expect(recordDatabaseWrite).toHaveBeenCalledTimes(2);
  });

  it("authenticates before decoding a malformed stream body", async () => {
    authenticate.mockRejectedValueOnce(
      new Error("private authentication backend detail"),
    );
    const run = vi.fn(async function* () {
      yield { n: 1 };
    });
    const response = await workflowStreamResponse(
      {
        request: new Request("https://cubby.test/api/workflow-stream/test", {
          method: "POST",
          body: "not-json",
        }),
        operation: "ai.backfillLocationDescriptions",
        inputSchema: z.object({}),
        eventSchema: z.object({ n: z.number() }),
        run,
      },
      runtime,
    );
    const body = await response.text();
    const frame = streamFrameSchema.parse(JSON.parse(body.trim()));
    expect(frame.error?.diagnostics).toMatchObject({
      stage: "context",
      causes: [],
    });
    expect(body).not.toContain("private authentication backend detail");
    expect(run).not.toHaveBeenCalled();
  });

  it("notifies when cancellation follows committed progress", async () => {
    const response = await responseFor(
      "ai.backfillLocationDescriptions",
      async function* (_context, _input, signal) {
        yield { n: 1 };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected a readable workflow stream");

    await reader.read();
    await reader.cancel("consumer cancelled");

    await vi.waitFor(() => {
      expect(recordDatabaseWrite.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
