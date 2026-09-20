import { gardenEntryOut } from "@cubby/schemas/garden-entry";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { EntityEditDialog } from "./entity-edit-dialog";
import { createEntityMutationPort } from "./use-entity-commands";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function gardenEntryPort(action: "create" | "update" = "create") {
  const created = mock(gardenEntryOut, { seed: 3, overrides: { images: [] } });
  const transport = vi.fn(async () =>
    entityBrowserMutationResultSchema.parse({
      action,
      entity: "gardenEntry",
      item: created,
      sideEffects: { backgroundBatches: [] },
    }),
  );
  const mutation = entityMutation.mutate.withTransport(transport);
  const entityTransport: EntityMutationTransport = {
    execute: async (command) =>
      await mutation.forEntity(command.entity).call(command),
  };
  return { mutationPort: createEntityMutationPort(entityTransport), transport };
}

describe("EntityEditDialog generic create", () => {
  // Regression: the generic presentation minted a new `Fields` component on
  // every render, so the first value change (a date committing on blur)
  // remounted the whole form, dropped focus mid-click, and lost the field
  // typed next. Same controls must survive a value change.
  it("keeps its controls mounted across value changes and sends every filled field", async () => {
    const { mutationPort, transport } = gardenEntryPort();
    render(
      <EntityEditDialog
        open
        onOpenChange={() => undefined}
        mutationPort={mutationPort}
        request={{
          entity: "gardenEntry",
          operation: "create",
          intent: "full",
          seed: {
            plantingId: testShortcode("planting", "PLT-4K7M"),
            locationId: testShortcode("location", "LOC-4K7M"),
          },
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("New Garden Entry")).toBeInTheDocument();
    expect(screen.getByLabelText("Planting", { exact: true })).toHaveValue(
      "PLT-4K7M",
    );
    const harvest = screen.getByLabelText("Harvest amount", { exact: true });
    const observed = screen.getByLabelText("Observed", { exact: true });
    fireEvent.change(observed, { target: { value: "2026-08-20" } });
    fireEvent.blur(observed);
    await waitFor(() =>
      expect(screen.getByLabelText("Observed", { exact: true })).toHaveValue(
        "Aug 20, 2026",
      ),
    );
    expect(screen.getByLabelText("Harvest amount", { exact: true })).toBe(
      harvest,
    );
    fireEvent.change(harvest, { target: { value: "A handful" } });
    fireEvent.change(screen.getByLabelText("Note", { exact: true }), {
      target: { value: "First harvest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({
            plantingId: "PLT-4K7M",
            observedOn: "2026-08-20",
            harvestAmount: "A handful",
            note: "First harvest",
          }),
        }),
      }),
    );
  });

  it("clears the singular planting link through the update API", async () => {
    const { mutationPort, transport } = gardenEntryPort("update");
    const currentPlantingId = testShortcode("planting", "PLT-4K7M");
    const record = mock(gardenEntryOut, {
      seed: 4,
      overrides: { images: [], plantingId: currentPlantingId },
    });
    render(
      <EntityEditDialog
        open
        onOpenChange={() => undefined}
        mutationPort={mutationPort}
        request={{
          entity: "gardenEntry",
          operation: "update",
          intent: "full",
          record,
        }}
      />,
      { wrapper: harness.wrapper },
    );

    const planting = await screen.findByRole("combobox", { name: "Planting" });
    expect(planting).toHaveValue(currentPlantingId);
    fireEvent.keyDown(planting, { key: "ArrowDown" });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear Planting" }).at(-1)!,
    );
    await waitFor(() => expect(planting).toHaveValue(""));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({ plantingId: null }),
        }),
      }),
    );
  });
});
