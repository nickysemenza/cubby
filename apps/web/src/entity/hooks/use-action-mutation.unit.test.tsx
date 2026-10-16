import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { useActionMutation } from "./use-action-mutation";

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
