import { gardenEntryOut } from "@cubby/schemas/garden";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { entityMutation } from "~/entities/entity-mutation.functions";
import { imageUpload } from "~/lib/image.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";

import { EntryForm } from "./entry-form";
import {
  uploadGardenPhotos,
  type GardenPhotoDraft,
  type GardenPhotoTransport,
} from "./garden-photos";
import { garden } from "./garden.functions";

const loadOptions = garden.options.withTransport(async () => ({
  locations: [
    {
      id: testShortcode("location", "LOC-4K7M"),
      name: "Test bed",
      gardenKind: "bed",
      gardenConditions: null,
    },
  ],
  ingredients: [],
  products: [],
  plantings: [
    {
      id: testShortcode("planting", "PLT-4K7M"),
      name: "Test tomato",
      locationId: testShortcode("location", "LOC-4K7M"),
      locationName: "Test bed",
      status: "growing",
    },
  ],
}));

describe("Garden entry capture", () => {
  it("lets an existing whole-bed observation be assigned to a planting without recreating it", async () => {
    const harness = createBrowserTestHarness();
    const entry = gardenEntryOut.parse({
      id: testShortcode("gardenEntry", "GDE-4K7M"),
      locationId: testShortcode("location", "LOC-4K7M"),
      locationName: "Test bed",
      plantingId: null,
      plantingName: null,
      kind: "observation",
      observedOn: "2026-08-15",
      note: "Broad view",
      harvestAmount: null,
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const requests: unknown[] = [];
    const mutate = entityMutation.mutate.withTransport(async ({ input }) => {
      const command = entityBrowserMutationCommandSchema.parse(input);
      requests.push(command);
      return {
        action: "update" as const,
        entity: "gardenEntry" as const,
        item: entry,
        sideEffects: { backgroundBatches: [] },
      };
    });
    try {
      render(
        <EntryForm
          entry={entry}
          locationId={entry.locationId}
          loadOptions={loadOptions}
          operations={{ recordEntry: garden.recordEntry, mutate }}
          onSaved={() => {}}
          onCancel={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        screen.getByText(/Shared with plantings known to be here/),
      ).toBeVisible();
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", {
            name: "Location where this happened",
          }),
        ).toHaveValue("Test bed"),
      );
      const about = screen.getByRole("combobox", { name: "About" });
      about.focus();
      fireEvent.keyDown(about, { key: "ArrowDown" });
      fireEvent.click(
        await screen.findByRole("option", { name: /Test tomato/ }),
      );
      expect(
        screen.getByText(/This entry stays in this planting/),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toMatchObject({
        action: "update",
        id: entry.id,
        data: {
          locationId: entry.locationId,
          plantingId: "PLT-4K7M",
          observedOn: entry.observedOn,
        },
      });
    } finally {
      harness.dispose();
    }
  });

  it("retains a backdated harvest after a failed save and retries the same entry", async () => {
    const harness = createBrowserTestHarness();
    const locationId = testShortcode("location", "LOC-4K7M");
    const requests: unknown[] = [];
    let saved = false;
    const recordEntry = garden.recordEntry.withTransport(async ({ input }) => {
      const data = garden.recordEntry.definition.input.parse(input);
      requests.push(data);
      if (requests.length === 1) throw new Error("Connection interrupted");
      return gardenEntryOut.parse({
        ...data,
        id: testShortcode("gardenEntry", "GDE-4K7M"),
        name: "Harvest",
        plantingId: null,
        locationName: "Test bed",
        plantingName: null,
        images: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    try {
      render(
        <EntryForm
          locationId={locationId}
          loadOptions={loadOptions}
          operations={{ recordEntry, mutate: entityMutation.mutate }}
          onSaved={() => {
            saved = true;
          }}
          onCancel={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      fireEvent.change(screen.getByLabelText("Entry type"), {
        target: { value: "harvest" },
      });
      fireEvent.change(screen.getByLabelText("Observation date"), {
        target: { value: "2026-08-15" },
      });
      fireEvent.change(screen.getByLabelText("Harvest amount (optional)"), {
        target: { value: "A handful" },
      });
      fireEvent.change(screen.getByLabelText("Notes"), {
        target: { value: "First ripe fruit" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Connection interrupted",
      );
      expect(screen.getByLabelText("Harvest amount (optional)")).toHaveValue(
        "A handful",
      );
      expect(screen.getByLabelText("Observation date")).toHaveValue(
        "2026-08-15",
      );
      fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
      await waitFor(() => expect(saved).toBe(true));
      expect(requests[1]).toEqual(requests[0]);
    } finally {
      harness.dispose();
    }
  });

  it("keeps complete scene bytes and reuses successful photos when a later PUT fails", async () => {
    const first = new File(["whole garden scene"], "bed.jpg", {
      type: "image/jpeg",
    });
    const second = new File(["close up"], "crop.jpg", { type: "image/jpeg" });
    const photos: GardenPhotoDraft[] = [{ file: first }, { file: second }];
    const putBodies: unknown[] = [];
    let initializations = 0;
    let puts = 0;
    const transport: GardenPhotoTransport = {
      initiate: imageUpload.uploadImage.withTransport(async () => {
        initializations += 1;
        return {
          imageId: testShortcode(
            "image",
            initializations === 1 ? "IMG-4K7M" : "IMG-9Q2X",
          ),
          uploadUrl: "https://storage.example.test/upload",
          key: "example.jpg",
          url: "https://storage.example.test/example.jpg",
        };
      }),
      put: async (_input, init) => {
        puts += 1;
        putBodies.push(init?.body);
        return new Response(null, { status: puts === 2 ? 503 : 200 });
      },
    };
    await expect(uploadGardenPhotos(photos, transport)).rejects.toThrow(
      "Could not upload crop.jpg",
    );
    expect(photos[0]?.uploadedId).toBe("IMG-4K7M");
    expect(await uploadGardenPhotos(photos, transport)).toEqual([
      "IMG-4K7M",
      "IMG-9Q2X",
    ]);
    expect(putBodies).toEqual([first, second, second]);
    expect(initializations).toBe(3);
  });

  it("keeps move dates and links fixed while allowing note corrections", async () => {
    const harness = createBrowserTestHarness();
    const locationId = testShortcode("location", "LOC-4K7M");
    const entry = gardenEntryOut.parse({
      id: testShortcode("gardenEntry", "GDE-4K7M"),
      locationId,
      plantingId: testShortcode("planting", "PLT-4K7M"),
      locationName: "Test bed",
      plantingName: "Test tomato",
      kind: "move",
      observedOn: "2026-06-01",
      note: "Moved to the sunny bed",
      harvestAmount: null,
      images: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const requests: unknown[] = [];
    const mutate = entityMutation.mutate.withTransport(async ({ input }) => {
      const command = entityBrowserMutationCommandSchema.parse(input);
      requests.push(command);
      if (command.action !== "update" || command.entity !== "gardenEntry")
        throw new Error("Expected a garden entry update.");
      return {
        action: "update" as const,
        entity: "gardenEntry" as const,
        item: entry,
        sideEffects: { backgroundBatches: [] },
      };
    });
    try {
      let saved = false;
      render(
        <EntryForm
          entry={entry}
          locationId={locationId}
          loadOptions={loadOptions}
          operations={{ recordEntry: garden.recordEntry, mutate }}
          onSaved={() => {
            saved = true;
          }}
          onCancel={() => {}}
        />,
        { wrapper: harness.wrapper },
      );
      expect(screen.getByLabelText("Observation date")).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "About" })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Notes"), {
        target: { value: "Moved to the sunny bed after all" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(saved).toBe(true));
      expect(requests).toEqual([
        expect.objectContaining({
          entity: "gardenEntry",
          action: "update",
          id: entry.id,
          data: expect.objectContaining({
            kind: "move",
            observedOn: "2026-06-01",
            note: "Moved to the sunny bed after all",
            pendingImageIds: [],
            removeImageIds: [],
          }),
        }),
      ]);
    } finally {
      harness.dispose();
    }
  });
});
