import { vendorOut } from "@cubby/schemas/vendor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityMutationTransport } from "~/entities/entity-contracts";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import { EntityEditDialog } from "./entity-edit-dialog";
import type { EntityMutationPort } from "./types";
import { createEntityMutationPort } from "./use-entity-commands";

const record = mock(vendorOut, {
  seed: 7,
  overrides: { id: "VEN-4K7M", name: "Example supplier" },
});
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function editorPort(beforeWrite: () => Promise<void> = async () => undefined) {
  const transport = vi.fn(async () => {
    await beforeWrite();
    return entityBrowserMutationResultSchema.parse({
      action: "update",
      entity: "vendor",
      item: record,
      sideEffects: { backgroundBatches: [] },
    });
  });
  const mutation = entityMutation.mutate.withTransport(transport);
  const entityTransport: EntityMutationTransport = {
    execute: async (command) =>
      await mutation.forEntity(command.entity).call(command),
  };
  return { mutationPort: createEntityMutationPort(entityTransport), transport };
}

function Editor({
  mutationPort,
  onSuccess,
}: {
  mutationPort: EntityMutationPort;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <EntityEditDialog
      open={open}
      onOpenChange={setOpen}
      mutationPort={mutationPort}
      onSuccess={onSuccess}
      request={{
        entity: "vendor",
        operation: "update",
        intent: "full",
        record,
      }}
    />
  );
}

describe("generic editor save lifecycle", () => {
  it("closes an unchanged edit without writing or invoking entity-result callbacks", async () => {
    const { mutationPort, transport } = editorPort();
    const onSuccess = vi.fn();
    render(<Editor mutationPort={mutationPort} onSuccess={onSuccess} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(transport).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("blocks dismissal during a write, preserves a failed draft, and closes after retry", async () => {
    let rejectWrite: (error: Error) => void = () => undefined;
    const pendingWrite = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const beforeWrite = vi.fn().mockImplementationOnce(() => pendingWrite);
    const { mutationPort, transport } = editorPort(beforeWrite);
    const onSuccess = vi.fn();
    render(<Editor mutationPort={mutationPort} onSuccess={onSuccess} />, {
      wrapper: harness.wrapper,
    });
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Updated supplier" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("Updated supplier");
    rejectWrite(new Error("Temporary save failure"));
    await screen.findByText("Temporary save failure");
    expect(name).toHaveValue("Updated supplier");
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
  it("focuses the first field refused asynchronously and keeps the entered value", async () => {
    const { mutationPort } = editorPort(async () => {
      throw new StartOperationError({
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: "Review these fields",
        validationIssues: [
          {
            code: "custom",
            path: ["data", "name"],
            message: "Choose a different name",
          },
          {
            code: "custom",
            path: ["data", "notes"],
            message: "Review the notes",
          },
        ],
      });
    });
    render(<Editor mutationPort={mutationPort} onSuccess={vi.fn()} />, {
      wrapper: harness.wrapper,
    });
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Updated supplier" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Choose a different name");
    expect(name).toHaveFocus();
    expect(name).toHaveValue("Updated supplier");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
