import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    let requestInit: RequestInit | undefined;
    const runtime: WorkflowStreamRuntime = {
      fetch: async (_input, init) => {
        requestInit = init;
        return responseFor({
          kind: "event",
          payload: superjson.serialize({ type: "progress", done: 1, at }),
        });
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

describe("production workflow stream runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the global fetch as a free function, not as a runtime method", async () => {
    // Regression: storing the native `fetch` on the runtime object made every
    // call `runtime.fetch(...)`, i.e. with the runtime as `this` — browsers
    // throw "Illegal invocation" for that, so no durable stream ever opened.
    const fetchMock = vi.fn(async () =>
      responseFor({
        kind: "event",
        payload: superjson.serialize({
          type: "progress",
          done: 1,
          at: new Date("2026-08-25T12:00:00.000Z"),
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = await openWorkflowStream({
      operation: "agent.askStream",
      kind: "query",
      url: "/api/workflows/test-progress",
      input: { id: "one" },
      eventSchema,
    });
    for await (const _event of stream) {
      // drain
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const receiver = fetchMock.mock.contexts[0];
    expect(receiver === undefined || receiver === globalThis).toBe(true);
  });
});
