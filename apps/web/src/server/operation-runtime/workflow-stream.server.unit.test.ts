import { testUserId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createDatabase } from "~/server/db/database-runtime";
import { withErrorReporting } from "~/server/errors/report-error";
import { systemPrincipal } from "~/server/http/authenticate";
import { requireActor } from "~/server/http/request-context";
import type { AppSpan } from "~/server/observability/tracing";
import { publicStartOperationErrorSchema } from "~/server/operation-runtime/start-operation.contract";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  type WorkflowStreamRuntime,
  workflowStream,
} from "./workflow-stream.server";

const database = createDatabase(() => {
  throw new Error("The workflow stream unit test must not resolve a database");
});
const context = requireActor(
  createTestRequestContext(database, {
    auth: { userId: testUserId("workflow-stream-user") },
  }),
);

const request = () =>
  new Request("https://cubby.test/_serverFn/ai.backfillLocationDescriptions", {
    method: "POST",
  });

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
  workflowStream(
    {
      request: request(),
      input: {},
      operation,
      inputSchema: z.object({}),
      eventSchema: z.object({ n: z.number() }),
      run,
    },
    runtime,
  );

const collect = async <T>(stream: ReadableStream<T>) => {
  const values: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return values;
      values.push(value);
    }
  } finally {
    reader.releaseLock();
  }
};

const streamFrameSchema = z.object({
  ok: z.boolean(),
  error: publicStartOperationErrorSchema.optional(),
});

describe("workflow stream freshness notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue(
      systemPrincipal(context, { channel: "browser", credential: "cookie" }),
    );
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

    await collect(response);

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

    const frames = (await collect(response)).map((frame) =>
      streamFrameSchema.parse(frame),
    );

    expect(frames.map((frame) => frame.ok)).toEqual([true, false]);
    expect(frames[1]?.error).toMatchObject({
      message: "later batch failed",
      diagnostics: { sentryEventId: "sample-stream-event", stage: "run" },
    });
    expect(recordDatabaseWrite).toHaveBeenCalledTimes(2);
  });

  it("authenticates before validating malformed domain input", async () => {
    authenticate.mockRejectedValueOnce(
      new Error("private authentication backend detail"),
    );
    const run = vi.fn(async function* () {
      yield { n: 1 };
    });
    const response = await workflowStream(
      {
        request: new Request("https://cubby.test/_serverFn/test", {
          method: "POST",
        }),
        input: "not-an-object",
        operation: "ai.backfillLocationDescriptions",
        inputSchema: z.object({}),
        eventSchema: z.object({ n: z.number() }),
        run,
      },
      runtime,
    );
    const frames = await collect(response);
    const frame = streamFrameSchema.parse(frames[0]);
    expect(frame.error?.diagnostics).toMatchObject({
      stage: "context",
      causes: [],
    });
    expect(JSON.stringify(frames)).not.toContain(
      "private authentication backend detail",
    );
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
    const reader = response.getReader();

    await reader.read();
    await reader.cancel("consumer cancelled");

    await vi.waitFor(() => {
      expect(recordDatabaseWrite.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
