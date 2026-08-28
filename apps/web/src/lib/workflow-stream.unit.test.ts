import superjson from "superjson";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";

import { openWorkflowStream } from "./workflow-stream";
import type { WorkflowStreamRuntime } from "./workflow-stream";

const eventSchema = z.object({
  type: z.literal("progress"),
  done: z.number(),
  at: z.date(),
});

const responseFor = (...frames: unknown[]) =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

describe("workflow JSONL stream", () => {
  it("parses progressive SuperJSON events", async () => {
    const at = new Date("2026-08-25T12:00:00.000Z");
    let freshReads = 0;
    let requestInit: RequestInit | undefined;
    const runtime: WorkflowStreamRuntime = {
      fetch: async (_input, init) => {
        requestInit = init;
        return responseFor({
          kind: "event",
          payload: superjson.serialize({ type: "progress", done: 1, at }),
        });
      },
      markFreshReads: () => {
        freshReads += 1;
      },
    };

    const stream = await openWorkflowStream(
      {
        operation: "agent.askStream",
        kind: "mutation",
        url: "/api/workflows/test-progress",
        input: { id: "one" },
        eventSchema,
      },
      runtime,
    );

    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([{ type: "progress", done: 1, at }]);
    expect(freshReads).toBe(1);
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("x-cubby-operation")).toBe("agent.askStream");
    expect(headers.get("x-cubby-operation-kind")).toBe("subscription");
    expect(headers.get("x-cubby-operation-id")).toBeNull();
  });

  it("raises the shared structured operation error", async () => {
    const runtime: WorkflowStreamRuntime = {
      fetch: async () =>
        responseFor({
          kind: "error",
          error: {
            code: "BAD_REQUEST",
            reason: "INVALID_INPUT",
            message: "Invalid input",
          },
        }),
      markFreshReads: () => undefined,
    };

    const stream = await openWorkflowStream(
      {
        operation: "agent.askStream",
        kind: "mutation",
        url: "/api/workflows/test-failure",
        input: null,
        eventSchema,
      },
      runtime,
    );

    await expect(async () => {
      for await (const _event of stream) {
        // The error frame terminates before an event can be yielded.
      }
    }).rejects.toBeInstanceOf(StartOperationError);
  });
});
