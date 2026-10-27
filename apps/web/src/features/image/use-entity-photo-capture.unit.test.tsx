import { imageOut } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import { testShortcode } from "@cubby/schemas/testing";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entity/entity-mutation-command";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { imageUpload } from "~/integrations/tanstack-query/generated/catalog/imageUpload.gen";
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
    fields: {
      url: fieldValueFixture(
        imageOut.shape.fields.shape.url,
        "https://images.example.test/after.jpg",
      ),
      representations: fieldValueFixture(
        imageOut.shape.fields.shape.representations,
        null,
      ),
    },
  },
});

function fakeUploadImage() {
  const url = publicImageUrl(newImage);
  if (!url) throw new Error("Synthetic uploaded Image has no URL");
  return imageUpload.uploadImage.withTransport(async () => ({
    imageId: newImage.id,
    uploadUrl: "https://storage.example.test/upload",
    key: "after.jpg",
    url,
  }));
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
        return {
          action: "update",
          entity: "location",
          item: { id: locationId },
          appliedFields: [],
          sideEffects: {},
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
          readImages: async () => [oldImage, newImage],
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
          item: { id: locationId },
          appliedFields: [],
          sideEffects: {},
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
          readImages: async () => [oldImage, newImage],
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
          item: { id: locationId },
          appliedFields: [],
          sideEffects: {},
        };
      },
    };

    const { result } = renderHook(
      () =>
        useEntityPhotoCapture("location", {
          transport,
          uploadImageOperation: fakeUploadImage(),
          readImages: async () => [newImage],
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
          item: { id: locationId },
          appliedFields: [],
          sideEffects: {},
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
