import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createEntityMutationPort } from "~/entity/editing/use-entity-commands";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import {
  useActionMutation,
  useEntityActionMutation,
} from "./use-action-mutation";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

// Suggestion receipts run after the remote write. The mutation must not settle
// early: callers use its pending state and returned promise to guard dismissal.
it("awaits caller success work before resolving and clearing pending", async () => {
  let complete: () => void = () => undefined;
  const receipt = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onSuccess = vi.fn(async () => {
    await receipt;
  });
  const { result } = renderHook(
    () =>
      useActionMutation({
        mutationFn: () => ({ mutationFn: async (_input: void) => "saved" }),
        onSuccess,
      }),
    { wrapper: harness.wrapper },
  );
  const settled = vi.fn();
  let write: Promise<string> = Promise.resolve("");
  act(() => {
    write = result.current.mutateAsync().then((data) => {
      settled();
      return data;
    });
  });
  await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(settled).not.toHaveBeenCalled();
  expect(result.current.isPending).toBe(true);
  await act(async () => {
    complete();
    await write;
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(settled).toHaveBeenCalledTimes(1);
});

// Detail fields delegate through an outer presentation mutation. The command
// must reach transport rather than queue behind the outer mutation it serves.
it("saves a Task field through the delegating action and returns its receipt", async () => {
  const execute = vi.fn(async () =>
    entityBrowserMutationResultSchema.parse({
      action: "update",
      entity: "task",
      item: { id: "TSK-4K7M", name: "Sample filter" },
      appliedFields: ["name"],
      sideEffects: {},
    }),
  );
  const { result } = renderHook(
    () =>
      useEntityActionMutation({
        entity: "task",
        operation: "update",
        mutationFn: entityMutationOptionsFactory("task", "update"),
        mutationPort: createEntityMutationPort({ execute }),
      }),
    { wrapper: harness.wrapper },
  );
  let saved: ReturnType<typeof result.current.mutateAsync> | undefined;
  act(() => {
    saved = result.current.mutateAsync({
      id: "TSK-4K7M",
      data: { name: "Sample filter" },
    });
  });
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await act(async () => {
    expect(await saved).toMatchObject({
      id: "TSK-4K7M",
      name: "Sample filter",
    });
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
});
