import { imageOut } from "@cubby/schemas/image";
import { locationOut } from "@cubby/schemas/location";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { EntityEditDialog } from "./entity-edit-dialog";
import { createEntityMutationPort } from "./use-entity-commands";

const images = ["IMG-AAAA", "IMG-BBBB", "IMG-CCCC"].map((id, index) =>
  mock(imageOut, {
    seed: index,
    overrides: {
      id,
      url: `https://images.example/${id}.jpg`,
      filename: `photo-${index + 1}.jpg`,
      key: `key-${id}`,
    },
  }),
);

const record = mock(locationOut, {
  seed: 7,
  overrides: {
    id: "LOC-4K7M",
    name: "Garage shelf",
    aliases: [],
    type: "room",
    tags: [],
    images,
  },
});

function locationMutationPort() {
  const transport = vi.fn(async () =>
    entityBrowserMutationResultSchema.parse({
      action: "update",
      entity: "location",
      item: record,
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

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

/**
 * `imageOrder` has no stored twin on the record (`images` is the read shape),
 * so its baseline is derived: an untouched gallery must send no order, and a
 * reordered one must send exactly the new order. Neither is a type error.
 */
describe("EntityEditDialog image reorder", () => {
  it("sends imageOrder as the new order after a reorder and omits it when untouched", async () => {
    const { mutationPort, transport } = locationMutationPort();
    render(
      <EntityEditDialog
        open
        onOpenChange={() => undefined}
        mutationPort={mutationPort}
        request={{
          entity: "location",
          operation: "update",
          intent: "full",
          record,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("Edit Location")).toBeInTheDocument();
    expect(screen.getByText("Existing images")).toBeInTheDocument();

    // Untouched: a name change alone carries no image instruction.
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Garage shelf B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          data: expect.objectContaining({ name: "Garage shelf B" }),
        }),
      }),
    );
    for (const key of ["imageOrder", "removeImageIds", "pendingImageIds"])
      expect(transport).not.toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            data: expect.objectContaining({ [key]: expect.anything() }),
          }),
        }),
      );
  });

  it("sends the reordered ids as imageOrder", async () => {
    const { mutationPort, transport } = locationMutationPort();
    render(
      <EntityEditDialog
        open
        onOpenChange={() => undefined}
        mutationPort={mutationPort}
        request={{
          entity: "location",
          operation: "update",
          intent: "full",
          record,
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("Existing images")).toBeInTheDocument();
    // "Make cover" moves the last image to the front: [C, A, B].
    const makeCover = screen.getAllByTitle("Make cover");
    fireEvent.click(makeCover[makeCover.length - 1]!);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          action: "update",
          entity: "location",
          id: "LOC-4K7M",
          data: expect.objectContaining({
            imageOrder: ["IMG-CCCC", "IMG-AAAA", "IMG-BBBB"],
          }),
        }),
      }),
    );
  });
});
