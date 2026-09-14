import { imageOut } from "@cubby/schemas/image";
import { locationOut } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import { useEntityPhotoCapture } from "./use-entity-photo-capture";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  );
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

const locationId = testShortcode("location", "LOC-4K7M");
const oldImage = mock(imageOut, {
  seed: 1,
  overrides: {
    id: testShortcode("image", "IMG-OLD1"),
    filename: "before.jpg",
  },
});
const newImage = mock(imageOut, {
  seed: 2,
  overrides: {
    id: testShortcode("image", "IMG-NEW1"),
    filename: "after.jpg",
  },
});

function fakeUploadImage() {
  return imageUpload.uploadImage.withTransport(async () => ({
    imageId: newImage.id,
    uploadUrl: "https://storage.example.test/upload",
    key: "after.jpg",
    url: newImage.url,
  }));
}

function locationRecord(images: (typeof oldImage)[]) {
  return mock(locationOut, {
    seed: 3,
    overrides: { id: locationId, images },
  });
}

describe("useEntityPhotoCapture", () => {
  it("uploads, attaches, and reorders the new photo to cover when other images exist", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        if (command.action !== "update" || command.entity !== "location") {
          throw new Error("expected a location update");
        }
        const attaching = "pendingImageIds" in command.data;
        return {
          action: "update",
          entity: "location",
          item: locationRecord(
            attaching ? [oldImage, newImage] : [newImage, oldImage],
          ),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
        }),
      { wrapper: harness.wrapper },
    );

    const file = new File(["data"], "after.jpg", { type: "image/jpeg" });
    let captured: string | undefined;
    await act(async () => {
      captured = await result.current.capture(locationId, file);
    });

    expect(captured).toBe(newImage.id);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      action: "update",
      id: locationId,
      data: { pendingImageIds: [newImage.id] },
    });
    expect(commands[1]).toMatchObject({
      action: "update",
      id: locationId,
      data: { imageOrder: [newImage.id, oldImage.id] },
    });
  });

  it("skips the reorder round trip when asCover is false, even with other images present", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "location",
          item: locationRecord([oldImage, newImage]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
        }),
      { wrapper: harness.wrapper },
    );

    const file = new File(["data"], "after.jpg", { type: "image/jpeg" });
    let captured: string | undefined;
    await act(async () => {
      captured = await result.current.capture(locationId, file, {
        asCover: false,
      });
    });

    expect(captured).toBe(newImage.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      action: "update",
      id: locationId,
      data: { pendingImageIds: [newImage.id] },
    });
  });

  it("skips the reorder round trip when the entity had no other images", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "location",
          item: locationRecord([newImage]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
        }),
      { wrapper: harness.wrapper },
    );

    const file = new File(["data"], "after.jpg", { type: "image/jpeg" });
    await act(async () => {
      await result.current.capture(locationId, file);
    });

    expect(commands).toHaveLength(1);
  });

  it("discardCapture detaches exactly the requested image", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "location",
          item: locationRecord([oldImage]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };

    const { result } = renderHook(
      () => useEntityPhotoCapture("location", { transport }),
      { wrapper: harness.wrapper },
    );

    await act(async () => {
      await result.current.discardCapture(locationId, newImage.id);
    });

    expect(commands).toEqual([
      {
        action: "update",
        entity: "location",
        id: locationId,
        data: { removeImageIds: [newImage.id] },
      },
    ]);
  });
});
