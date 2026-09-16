import { imageOut } from "@cubby/schemas/image";
import { mealOut } from "@cubby/schemas/meal";
import {
  buildNutrition,
  nutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import { EntityPhotosSection } from "./entity-photos-section";

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

const mealId = testShortcode("meal", "MEL-4K7M");
const existing = imageOut.parse(
  mock(imageOut, {
    seed: 1,
    overrides: {
      id: testShortcode("image", "IMG-OLD1"),
      filename: "plate.jpg",
    },
  }),
);
// `mock()`'s random `nutritionTotals` almost never satisfies its own
// `covered <= total` coverage refinement (independent per-nutrient random
// ints rarely land in order across all 22 keys, times two for `recipes[]`),
// so every nutrient is pinned to the "unavailable" branch instead, which
// carries no `coverage` field at all. Built once, at import time, and reused
// by every test below — only `images` varies per case.
const zeroTotals = nutritionTotals.parse(
  withMacros({
    cost: { status: "unavailable", reason: "no_data" },
    nutrition: buildNutrition(() => ({
      status: "unavailable",
      reason: "no_data",
    })),
  }),
);
const mealTemplate = mock(mealOut, {
  seed: 2,
  overrides: { id: mealId, recipes: [], totals: zeroTotals },
});
const mealRecordWithImages = (images: (typeof existing)[]) => ({
  ...mealTemplate,
  images,
});

function chooseFiles(...files: File[]) {
  fireEvent.change(screen.getByLabelText("Choose photos"), {
    target: { files },
  });
}

describe("EntityPhotosSection", () => {
  it("detaches an existing photo on remove", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "meal",
          item: mealRecordWithImages([]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };

    render(
      <EntityPhotosSection
        entity="meal"
        id={mealId}
        images={[existing]}
        transport={transport}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove plate.jpg" }));

    await waitFor(() =>
      expect(commands).toEqual([
        {
          action: "update",
          entity: "meal",
          id: mealId,
          data: { removeImageIds: [existing.id] },
        },
      ]),
    );
  });

  it("attaches a batch of new photos sequentially, in pick order, with no cover reorder", async () => {
    const events: string[] = [];
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        events.push(`attach:${JSON.stringify(command)}`);
        commands.push(command);
        if (command.action !== "update" || command.entity !== "meal") {
          throw new Error("expected a meal update");
        }
        return {
          action: "update",
          entity: "meal",
          item: mealRecordWithImages([existing]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };
    const uploadImageOperation = imageUpload.uploadImage.withTransport(
      async ({ input: { filename } }) => {
        events.push(`upload-init:${filename}`);
        return {
          imageId: testShortcode(
            "image",
            filename === "first.jpg" ? "IMG-NEW1" : "IMG-NEW2",
          ),
          uploadUrl: "https://storage.example.test/upload",
          key: filename,
          url: `https://storage.example.test/${filename}`,
        };
      },
    );

    render(
      <EntityPhotosSection
        entity="meal"
        id={mealId}
        images={[]}
        transport={transport}
        uploadImageOperation={uploadImageOperation}
      />,
      { wrapper: harness.wrapper },
    );

    const first = new File(["1"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["2"], "second.jpg", { type: "image/jpeg" });
    chooseFiles(first, second);

    await waitFor(() => expect(commands).toHaveLength(2), { timeout: 5000 });

    // Strictly sequential — file 2's upload never starts until file 1's
    // attach command has already landed, not just resolved in submission order.
    expect(events).toEqual([
      "upload-init:first.jpg",
      `attach:${JSON.stringify({
        action: "update",
        entity: "meal",
        id: mealId,
        data: { pendingImageIds: [testShortcode("image", "IMG-NEW1")] },
      })}`,
      "upload-init:second.jpg",
      `attach:${JSON.stringify({
        action: "update",
        entity: "meal",
        id: mealId,
        data: { pendingImageIds: [testShortcode("image", "IMG-NEW2")] },
      })}`,
    ]);
    // `asCover: false` — never a second, order-only round trip.
    expect(
      commands.every(
        (command) =>
          command.action === "update" && !("imageOrder" in command.data),
      ),
    ).toBe(true);
  });

  it("stops the batch on a failure, leaving the already-attached photo attached", async () => {
    const commands: EntityBrowserMutationInput[] = [];
    const transport: EntityMutationTransport = {
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "meal",
          item: mealRecordWithImages([existing]),
          sideEffects: { backgroundBatches: [] },
        };
      },
    };
    const uploadImageOperation = imageUpload.uploadImage.withTransport(
      async ({ input: { filename } }) => {
        if (filename === "second.jpg") {
          throw new Error("Upload initialization failed");
        }
        return {
          imageId: testShortcode("image", "IMG-NEW1"),
          uploadUrl: "https://storage.example.test/upload",
          key: filename,
          url: `https://storage.example.test/${filename}`,
        };
      },
    );

    render(
      <EntityPhotosSection
        entity="meal"
        id={mealId}
        images={[]}
        transport={transport}
        uploadImageOperation={uploadImageOperation}
      />,
      { wrapper: harness.wrapper },
    );

    const first = new File(["1"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["2"], "second.jpg", { type: "image/jpeg" });
    chooseFiles(first, second);

    // The batch settles (button re-enables) once file 2's failure has been
    // caught and the loop has stopped — never retried or superseded by
    // another attempt.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add photos" }),
      ).not.toBeDisabled(),
    );

    // Exactly one attach reached the server — file 1's.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      action: "update",
      id: mealId,
      data: { pendingImageIds: [testShortcode("image", "IMG-NEW1")] },
    });
  });
});
