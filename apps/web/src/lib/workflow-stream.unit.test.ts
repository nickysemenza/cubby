import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";

import { openWorkflowStream } from "./workflow-stream";

const eventSchema = z.object({
  type: z.literal("progress"),
  done: z.number(),
  at: z.date(),
});

const responseFor = (...frames: unknown[]) =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("workflow JSONL stream", () => {
  it("parses progressive SuperJSON events", async () => {
    const at = new Date("2026-08-25T12:00:00.000Z");
    const documentStub = { cookie: "" };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFor({
          kind: "event",
          payload: superjson.serialize({ type: "progress", done: 1, at }),
        }),
      ),
    );

    const stream = await openWorkflowStream({
      operation: "agent.askStream",
      kind: "mutation",
      url: "/api/workflows/test-progress",
      input: { id: "one" },
      eventSchema,
    });

    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([{ type: "progress", done: 1, at }]);
    expect(documentStub.cookie).toContain("cubby-fresh-reads=1");
    const requestInit = vi.mocked(fetch).mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("x-cubby-operation")).toBe("agent.askStream");
    expect(headers.get("x-cubby-operation-kind")).toBe("subscription");
    expect(headers.get("x-cubby-operation-id")).toBeNull();
  });

  it("raises the shared structured operation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFor({
          kind: "error",
          error: {
            code: "BAD_REQUEST",
            reason: "INVALID_INPUT",
            message: "Invalid input",
          },
        }),
      ),
    );

    const stream = await openWorkflowStream({
      operation: "agent.askStream",
      kind: "mutation",
      url: "/api/workflows/test-failure",
      input: null,
      eventSchema,
    });

    await expect(async () => {
      for await (const _event of stream) {
        // The error frame terminates before an event can be yielded.
      }
    }).rejects.toBeInstanceOf(StartOperationError);
  });
});
