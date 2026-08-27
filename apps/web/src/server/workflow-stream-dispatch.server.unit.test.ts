import { describe, expect, it, vi } from "vitest";
import type { WorkflowStreamHandler } from "./subscription-domain.server";
import { dispatchWorkflowStream } from "./workflow-stream-dispatch.server";

const request = () =>
  new Request("https://cubby.test/api/workflow-stream/agent.askStream", {
    method: "POST",
  });

/** The dispatcher answers a refusal as one NDJSON error frame, not a throw. */
const refusal = async (response: Response) =>
  JSON.parse(await response.text()) as {
    kind: string;
    error: { code: string; reason: string; message: string };
  };

describe("workflow stream dispatcher", () => {
  it("loads only the selected stream's handler", async () => {
    const selected = vi.fn(async () => new Response("frames"));
    const selectedLoader = vi.fn(async () => selected);
    const unselectedLoader = vi.fn<() => Promise<WorkflowStreamHandler>>();
    const sent = request();

    const response = await dispatchWorkflowStream("agent.askStream", sent, {
      "agent.askStream": selectedLoader,
      "recipe.recomputeStaleDurable": unselectedLoader,
    });

    expect(await response.text()).toBe("frames");
    expect(selectedLoader).toHaveBeenCalledOnce();
    expect(unselectedLoader).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledWith({ request: sent });
  });

  /**
   * Streams and unary operations share one id space, so this is the guard that
   * keeps a query from being answered over NDJSON — which would read as a
   * working stream that never actually invalidates anything.
   */
  it("refuses a unary operation without loading anything", async () => {
    const loader = vi.fn<() => Promise<WorkflowStreamHandler>>();

    const response = await dispatchWorkflowStream("calendar.range", request(), {
      "calendar.range": loader,
    } as never);

    expect((await refusal(response)).error.message).toContain(
      "calendar.range is not a registered workflow stream",
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it("refuses an unregistered id before touching the loader table", async () => {
    const response = await dispatchWorkflowStream("not.registered", request(), {
      "agent.askStream": vi.fn<() => Promise<WorkflowStreamHandler>>(),
    });

    const frame = await refusal(response);
    expect(frame.kind).toBe("error");
    expect(frame.error.reason).toBe("UNKNOWN_OPERATION");
    expect(frame.error.message).toContain(
      "not.registered is not a registered workflow stream",
    );
  });

  it("refuses a declared stream that has no loader", async () => {
    const response = await dispatchWorkflowStream(
      "agent.askStream",
      request(),
      {},
    );

    expect((await refusal(response)).error.message).toContain(
      "No workflow stream handler is registered for agent.askStream",
    );
  });
});
