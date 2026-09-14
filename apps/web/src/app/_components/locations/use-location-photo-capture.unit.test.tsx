import { imageOut } from "@cubby/schemas/image";
import { locationOut } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { DEFERRED_INVALIDATION_DELAYS_MS } from "~/lib/deferred-invalidation";
import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import { useLocationPhotoCapture } from "./use-location-photo-capture";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness({ clock: { now: 0 } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  );
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const locationId = testShortcode("location", "LOC-4K7M");
const newImage = imageOut.parse(
  mock(imageOut, {
    seed: 1,
    overrides: {
      id: testShortcode("image", "IMG-NEW1"),
      filename: "after.jpg",
    },
  }),
);

describe("useLocationPhotoCapture", () => {
  it("schedules a deferred re-invalidation of location's tags after the immediate one from a capture", async () => {
    const transport: EntityMutationTransport = {
      execute: async (_command: EntityBrowserMutationInput) => ({
        action: "update",
        entity: "location",
        item: mock(locationOut, {
          seed: 2,
          overrides: { id: locationId, images: [newImage] },
        }),
        sideEffects: { backgroundBatches: [] },
      }),
    };
    const uploadImageOperation = imageUpload.uploadImage.withTransport(
      async () => ({
        imageId: newImage.id,
        uploadUrl: "https://storage.example.test/upload",
        key: "after.jpg",
        url: newImage.url,
      }),
    );

    const { result } = renderHook(
      () => useLocationPhotoCapture({ transport, uploadImageOperation }),
      { wrapper: harness.wrapper },
    );

    // Spied on the real collaborator the hook already receives through
    // `QueryClientProvider` — not a swapped-out module — so every real
    // invalidation this capture triggers (immediate and deferred) is visible.
    const invalidateQueries = vi.spyOn(
      harness.queryClient,
      "invalidateQueries",
    );

    const file = new File(["data"], "after.jpg", { type: "image/jpeg" });
    await act(async () => {
      await result.current.capture(locationId, file);
    });

    const callsRightAfterCapture = invalidateQueries.mock.calls.length;
    expect(callsRightAfterCapture).toBeGreaterThan(0);

    for (const delay of DEFERRED_INVALIDATION_DELAYS_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }

    expect(invalidateQueries.mock.calls.length).toBeGreaterThan(
      callsRightAfterCapture,
    );
  });
});
