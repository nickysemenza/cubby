import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  dispatchWorkflowStream,
  type WorkflowStreamLoaderPort,
} from "./workflow-stream-dispatch.server";

const request = () =>
  new Request("https://cubby.test/_serverFn/recipe.importCookbookStream", {
    method: "POST",
  });

/** Refusals retain the shared diagnostic envelope through Start serialization. */
const refusalSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    reason: z.string(),
    message: z.string(),
  }),
});
const refusal = async (
  stream: Awaited<ReturnType<typeof dispatchWorkflowStream>>,
) => {
  const reader = stream.getReader();
  try {
    return refusalSchema.parse((await reader.read()).value);
  } finally {
    reader.releaseLock();
  }
};

describe("workflow stream dispatcher", () => {
  it("loads only the selected stream's handler", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const selected = vi.fn(async () => stream);
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>(async () => selected);
    const sent = request();

    const response = await dispatchWorkflowStream(
      "recipe.importCookbookStream",
      sent,
      {},
      {
        load,
      },
    );

    expect(response).toBe(stream);
    expect(load).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith({ request: sent, input: {} });
  });

  /**
   * Streams and unary operations share one id space, so this is the guard that
   * keeps a query from being answered as a stream — which would read as a
   * working stream that never actually invalidates anything.
   */
  it("refuses a unary operation without loading anything", async () => {
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>();

    const response = await dispatchWorkflowStream(
      "calendar.range",
      request(),
      {},
      {
        load,
      },
    );

    expect((await refusal(response)).error.message).toContain(
      "calendar.range is not a registered workflow stream",
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses an unregistered id before touching the loader table", async () => {
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>();
    const response = await dispatchWorkflowStream(
      "not.registered",
      request(),
      {},
      {
        load,
      },
    );

    const frame = await refusal(response);
    expect(frame.ok).toBe(false);
    expect(frame.error.reason).toBe("UNKNOWN_OPERATION");
    expect(frame.error.message).toContain(
      "not.registered is not a registered workflow stream",
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a declared stream that has no loader", async () => {
    const response = await dispatchWorkflowStream(
      "recipe.importCookbookStream",
      request(),
      {},
      { load: () => undefined },
    );

    expect((await refusal(response)).error.message).toContain(
      "No workflow stream handler is registered for recipe.importCookbookStream",
    );
  });
});
