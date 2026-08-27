import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  onSuccess: vi.fn(),
}));

vi.mock("./useActionMutation", () => ({
  useActionMutation: (options: { onSuccess: () => void }) => {
    mocks.onSuccess.mockImplementation(options.onSuccess);
    return { isPending: false, mutateAsync: mocks.mutateAsync };
  },
}));

import { useStagedBulkAction } from "./useStagedBulkAction";

type Row = { id: string; name: string };

const rows = (...items: Row[]) =>
  items.map((original) => ({ original })) as never;

const setup = () =>
  renderHook(() =>
    useStagedBulkAction<Row, () => { mutationFn: () => Promise<unknown> }>({
      verb: "setTrade",
      // biome-ignore lint/suspicious/noExplicitAny: the mutation is mocked wholesale
      mutationFn: (() => ({})) as any,
      invalidateKeys: [],
    }),
  );

describe("useStagedBulkAction", () => {
  beforeEach(() => {
    mocks.mutateAsync.mockClear();
  });

  it("takes its label and icon from the verb registry", () => {
    const { result } = setup();
    expect(result.current.action.label).toBe("Set trade...");
    expect(result.current.action.id).toBe("set-trade");
  });

  it("stages the selection instead of writing", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(
        rows({ id: "TSK-1", name: "a" }, { id: "TSK-2", name: "b" }),
      );
    });
    expect(result.current.items).toEqual([
      { id: "TSK-1", name: "a" },
      { id: "TSK-2", name: "b" },
    ]);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  // The derivation each of the seven hand-written blocks used to repeat.
  it("derives ids from the staged rows and merges the dialog's value", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(
        rows({ id: "TSK-1", name: "a" }, { id: "TSK-2", name: "b" }),
      );
    });
    await act(async () => {
      await result.current.submit({ trade: "electrical" });
    });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      trade: "electrical",
      ids: ["TSK-1", "TSK-2"],
    });
  });

  it("clears the staged rows on success", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(rows({ id: "TSK-1", name: "a" }));
    });
    act(() => {
      mocks.onSuccess();
    });
    expect(result.current.items).toEqual([]);
  });

  it("cancel discards the staged rows without writing", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(rows({ id: "TSK-1", name: "a" }));
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.items).toEqual([]);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });
});
