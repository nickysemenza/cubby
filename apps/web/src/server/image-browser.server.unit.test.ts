import { describe, expect, it, vi } from "vitest";
import { imageHandlers } from "./image-browser.server";

const mocks = vi.hoisted(() => ({ executeEntity: vi.fn() }));

vi.mock("~/server/entity-kernel", () => ({
  executeEntity: mocks.executeEntity,
}));

vi.mock("~/server/start-operation.server", () => ({
  runStartOperation: async (options: {
    input: unknown;
    run: (context: object, input: unknown) => Promise<unknown>;
  }) => ({ ok: true, data: await options.run({}, options.input) }),
}));

describe("Image browser operations", () => {
  it("reloads the enriched projection after updating the row", async () => {
    mocks.executeEntity
      .mockResolvedValueOnce({
        action: "update",
        entity: "image",
        item: { id: "IMG-4K7M", filename: "renamed.jpg" },
        sideEffects: { backgroundBatches: [] },
      })
      .mockResolvedValueOnce({
        action: "get",
        entity: "image",
        item: {
          id: "IMG-4K7M",
          filename: "renamed.jpg",
          entityType: "PRODUCT",
          entityId: "PRD-4K7M",
        },
      });

    await expect(
      imageHandlers.operations.update({
        data: { id: "IMG-4K7M", data: { filename: "renamed.jpg" } },
        request: {
          headers: new Headers(),
          signal: new AbortController().signal,
        },
      }),
    ).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        id: "IMG-4K7M",
        entityType: "PRODUCT",
      }),
    });

    expect(mocks.executeEntity).toHaveBeenNthCalledWith(
      2,
      // The domain wrapper adds the request's abort signal to the context.
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({
        action: "get",
        entity: "image",
        id: "IMG-4K7M",
        missing: "error",
      }),
    );
  });
});
