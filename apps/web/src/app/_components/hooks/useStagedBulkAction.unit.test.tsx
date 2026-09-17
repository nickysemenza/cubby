import type { UseMutationOptions } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { CubbyRow as TableRow } from "../data-table/table-features";
import { useStagedBulkAction } from "./useStagedBulkAction";

interface Row {
  id: string;
  name: string;
}

interface TradeValues {
  trade: string;
}

interface MutationResult {
  updated: number;
}

interface MutationContext {
  source: "test";
}

type Payload = TradeValues & { ids: string[] };

const rows = (...items: Row[]) =>
  items.map((original) => fromPartial<TableRow<Row>>({ original }));

let harness: ReturnType<typeof createBrowserTestHarness>;
const mutate = vi.fn(async (_payload: Payload): Promise<MutationResult> => ({
  updated: 2,
}));

const mutationOptions = (): UseMutationOptions<
  MutationResult,
  Error,
  Payload,
  MutationContext
> => ({ mutationFn: mutate });

const setup = () =>
  renderHook(
    () =>
      useStagedBulkAction<
        Row,
        MutationResult,
        Error,
        TradeValues,
        MutationContext
      >({
        verb: "bulkEdit",
        mutationFn: mutationOptions,
      }),
    { wrapper: harness.wrapper },
  );

describe("useStagedBulkAction", () => {
  beforeEach(() => {
    harness = createBrowserTestHarness();
    mutate.mockClear();
  });

  afterEach(() => {
    harness.dispose();
  });

  it("takes its label and icon from the verb registry", () => {
    const { result } = setup();
    expect(result.current.action.label).toBe("Bulk edit...");
    expect(result.current.action.id).toBe("bulk-edit");
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
    expect(mutate).not.toHaveBeenCalled();
  });

  it("derives ids from the staged rows and merges the dialog value", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(
        rows({ id: "TSK-1", name: "a" }, { id: "TSK-2", name: "b" }),
      );
    });
    await act(async () => {
      await result.current.submit({ trade: "electrical" });
    });
    expect(mutate).toHaveBeenCalledWith(
      { trade: "electrical", ids: ["TSK-1", "TSK-2"] },
      expect.any(Object),
    );
  });

  it("clears the staged rows after a successful mutation", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(rows({ id: "TSK-1", name: "a" }));
      await result.current.submit({ trade: "electrical" });
    });
    expect(result.current.items).toEqual([]);
  });

  it("cancel discards the staged rows without writing", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.action.onExecute(rows({ id: "TSK-1", name: "a" }));
    });
    act(() => result.current.cancel());
    expect(result.current.items).toEqual([]);
    expect(mutate).not.toHaveBeenCalled();
  });
});
