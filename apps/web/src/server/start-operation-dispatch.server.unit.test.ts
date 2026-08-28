import { describe, expect, it, vi } from "vitest";

import { dispatchStartOperation } from "./start-operation-dispatch.server";

const request = {
  headers: new Headers(),
  signal: new AbortController().signal,
};

describe("browser Start operation dispatcher", () => {
  it("loads only the selected handler and forwards the exact data and request", async () => {
    const selectedHandler = vi.fn(async () => ({
      ok: true as const,
      data: { token: "rotated-calendar-feed" },
    }));
    const selectedLoader = vi.fn(async () => selectedHandler);
    const unselectedLoader = vi.fn(async () => selectedHandler);

    await expect(
      dispatchStartOperation(
        { operation: "calendar.rotateFeed", input: undefined, request },
        {
          "calendar.rotateFeed": selectedLoader,
          "calendar.getFeed": unselectedLoader,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      data: { token: "rotated-calendar-feed" },
    });

    expect(selectedLoader).toHaveBeenCalledOnce();
    expect(unselectedLoader).not.toHaveBeenCalled();
    expect(selectedHandler).toHaveBeenCalledWith({
      data: undefined,
      request,
    });
  });

  it("rejects an operation without a registered handler before lookup", async () => {
    await expect(
      dispatchStartOperation(
        {
          operation: "calendar.rotateFeed",
          input: undefined,
          request,
        },
        {},
      ),
    ).rejects.toThrow(
      "No browser handler is registered for calendar.rotateFeed",
    );
  });
});
