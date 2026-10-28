import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { createEntityMutationPort } from "~/entity/editing/use-entity-commands";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import {
  useActionMutation,
  useDeferredActionMutation,
  useEntityActionMutation,
} from "./use-action-mutation";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

// Advisory post-save work must not hold editor completion after acceptance.
it("finishes an accepted write while caller follow-up work is still pending", async () => {
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
  expect(settled).toHaveBeenCalledTimes(1);
  expect(result.current.isPending).toBe(false);
  await act(async () => {
    complete();
    await write;
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(settled).toHaveBeenCalledTimes(1);
});

it("keeps deferred loading pending and executes the declared operation in the mutation cache", async () => {
  let finishLoad: (options: {
    mutationKey: readonly string[];
    meta: { entity: string };
    mutationFn: (body: { value: string }) => Promise<string>;
  }) => void = () => undefined;
  const load = vi.fn(
    () =>
      new Promise<{
        mutationKey: readonly string[];
        meta: { entity: string };
        mutationFn: (body: { value: string }) => Promise<string>;
      }>((resolve) => {
        finishLoad = resolve;
      }),
  );
  const operation = vi.fn(async (body: { value: string }) => body.value);
  const { result } = renderHook(
    () => useDeferredActionMutation({ loadMutation: load }),
    { wrapper: harness.wrapper },
  );
  const body = { value: "synthetic payload" };
  let write: Promise<string> = Promise.resolve("");
  act(() => {
    write = result.current.mutateAsync(body);
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(result.current.isPending).toBe(true);
  expect(operation).not.toHaveBeenCalled();

  await act(async () => {
    finishLoad({
      mutationKey: ["catalog", "synthetic-operation"],
      meta: { entity: "synthetic-entity" },
      mutationFn: operation,
    });
    await expect(write).resolves.toBe("synthetic payload");
  });
  expect(operation).toHaveBeenCalledWith(
    body,
    expect.objectContaining({
      client: harness.queryClient,
      mutationKey: ["catalog", "synthetic-operation"],
      meta: { entity: "synthetic-entity" },
    }),
  );
  expect(
    harness.queryClient
      .getMutationCache()
      .findAll({ mutationKey: ["catalog", "synthetic-operation"] })
      .map((mutation) => mutation.meta),
  ).toContainEqual({ entity: "synthetic-entity" });
  await waitFor(() => expect(result.current.isPending).toBe(false));
});

it("routes loader and operation failures through the action error presentation", async () => {
  const toastError = vi
    .spyOn(toast, "error")
    .mockImplementation(() => "toast-id");
  const loaderError = new Error("catalog load failed");
  const loaderHook = renderHook(
    () =>
      useDeferredActionMutation({
        loadMutation: async () => {
          throw loaderError;
        },
        error: "Could not run action",
      }),
    { wrapper: harness.wrapper },
  );
  await act(async () => {
    await expect(loaderHook.result.current.mutateAsync("input")).rejects.toBe(
      loaderError,
    );
  });
  expect(toastError).toHaveBeenCalledWith(
    "Could not run action: catalog load failed",
    expect.anything(),
  );

  toastError.mockClear();
  const operationError = new Error("operation failed");
  const operationHook = renderHook(
    () =>
      useDeferredActionMutation({
        loadMutation: async () => ({
          mutationFn: async (_input: string) => {
            throw operationError;
          },
        }),
        error: "Could not run action",
      }),
    { wrapper: harness.wrapper },
  );
  await act(async () => {
    await expect(
      operationHook.result.current.mutateAsync("input"),
    ).rejects.toBe(operationError);
  });
  expect(toastError).toHaveBeenCalledTimes(1);
  expect(toastError).toHaveBeenCalledWith(
    "Could not run action: operation failed",
    expect.anything(),
  );
  toastError.mockRestore();
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
