import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  dispatchWorkflowStream,
  type WorkflowStreamLoaderPort,
} from "./workflow-stream-dispatch.server";

const request = () =>
  new Request(
    "https://cubby.test/api/workflow-stream/recipe.importCookbookStream",
    {
      method: "POST",
    },
  );

/** The dispatcher answers a refusal as one NDJSON error frame, not a throw. */
const refusalSchema = z.object({
  kind: z.literal("error"),
  error: z.object({
    code: z.string(),
    reason: z.string(),
    message: z.string(),
  }),
});
const refusal = async (response: Response) =>
  refusalSchema.parse(JSON.parse(await response.text()));

describe("workflow stream dispatcher", () => {
  it("loads only the selected stream's handler", async () => {
    const selected = vi.fn(async () => new Response("frames"));
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>(async () => selected);
    const sent = request();

    const response = await dispatchWorkflowStream(
      "recipe.importCookbookStream",
      sent,
      {
        load,
      },
    );

    expect(await response.text()).toBe("frames");
    expect(load).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith({ request: sent });
  });

  /**
   * Streams and unary operations share one id space, so this is the guard that
   * keeps a query from being answered over NDJSON — which would read as a
   * working stream that never actually invalidates anything.
   */
  it("refuses a unary operation without loading anything", async () => {
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>();

    const response = await dispatchWorkflowStream("calendar.range", request(), {
      load,
    });

    expect((await refusal(response)).error.message).toContain(
      "calendar.range is not a registered workflow stream",
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses an unregistered id before touching the loader table", async () => {
    const load = vi.fn<WorkflowStreamLoaderPort["load"]>();
    const response = await dispatchWorkflowStream("not.registered", request(), {
      load,
    });

    const frame = await refusal(response);
    expect(frame.kind).toBe("error");
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
      { load: () => undefined },
    );

    expect((await refusal(response)).error.message).toContain(
      "No workflow stream handler is registered for recipe.importCookbookStream",
    );
  });
});
