import { testUserId } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { dispatchStartOperation } from "./start-operation-dispatch.server";

const request = {
  verifiedContext: requireActor(
    createTestRequestContext(
      new Database(() => {
        throw new Error("No DB access expected");
      }),
      { auth: { userId: testUserId("dispatch-user") } },
    ),
  ),
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

  it("returns correlated loader failures before invoking a handler", async () => {
    await expect(
      dispatchStartOperation(
        {
          operation: "calendar.rotateFeed",
          input: undefined,
          request,
        },
        {},
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        message: "No browser handler is registered for calendar.rotateFeed",
        diagnostics: {
          origin: "server",
          operation: "calendar.rotateFeed",
          stage: "dispatch",
        },
      },
    });
  });
});
