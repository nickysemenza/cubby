import { describe, expect, it, vi } from "vitest";
import {
  dispatchStartOperation,
  type StartOperationHandler,
} from "./start-operation-dispatch.server";

const request = {
  headers: new Headers(),
  signal: new AbortController().signal,
};

describe("browser Start operation dispatcher", () => {
  it("loads only the selected handler and forwards the exact data and request", async () => {
    const selectedHandler = vi.fn(async () => ({ ok: true as const, data: 7 }));
    const selectedLoader = vi.fn(async () => selectedHandler);
    const unselectedLoader = vi.fn(async () => selectedHandler);
    const data = { start: "2026-08-25", end: "2026-08-31" };

    await expect(
      dispatchStartOperation(
        { operation: "calendar.range", input: data, request },
        {
          "calendar.range": selectedLoader,
          "calendar.getFeed": unselectedLoader,
        },
      ),
    ).resolves.toEqual({ ok: true, data: 7 });

    expect(selectedLoader).toHaveBeenCalledOnce();
    expect(unselectedLoader).not.toHaveBeenCalled();
    expect(selectedHandler).toHaveBeenCalledWith({ data, request });
  });

  it("rejects streams without loading their handler", async () => {
    const loader = vi.fn<() => Promise<StartOperationHandler>>();

    await expect(
      dispatchStartOperation(
        { operation: "agent.askStream", input: undefined, request },
        { "agent.askStream": loader } as never,
      ),
    ).rejects.toThrow("agent.askStream is a workflow stream");
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects an operation without a registered handler before lookup", async () => {
    await expect(
      dispatchStartOperation(
        {
          operation: "not.registered" as never,
          input: undefined,
          request,
        },
        {},
      ),
    ).rejects.toThrow("No browser handler is registered for not.registered");
  });
});
