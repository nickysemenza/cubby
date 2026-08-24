import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep's wiring, not its arithmetic — `planSweptBin` and `resolveProductScan`
 * are unit-tested where they live. What is only observable here is the order of
 * the two commit mutations, what a failure of each leaves behind, and the
 * anchor gate that keeps a scan read at one shelf from landing on the next.
 */

/** Cubby shortcodes exclude I, L, O, 0 and 1 — a fixture that ignores that is
 * rejected by the real resolver and the test passes for the wrong reason. */
const mocks = vi.hoisted(() => ({
  locations: new Map<string, unknown>(),
  scan: vi.fn(),
  resolveStrays: vi.fn(),
  reparent: vi.fn(),
  calls: [] as string[],
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("~/lib/query-keys", () => ({
  invalidateTRPCQueries: vi.fn(),
  invalidatesFor: () => [["location"]],
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    location: {
      bulkUpdateParent: {
        mutationOptions: () => ({
          mutationFn: (input: unknown) => {
            mocks.calls.push("bulkUpdateParent");
            return mocks.reparent(input);
          },
        }),
      },
      ensureGlobalUnknown: {
        mutationOptions: () => ({
          mutationFn: async () => ({ id: "LOC-UNK2" }),
        }),
      },
    },
    inventory: {
      scanAtLocation: {
        mutationOptions: () => ({
          mutationFn: (input: unknown) => mocks.scan(input),
        }),
      },
      resolveScanStrays: {
        mutationOptions: () => ({
          mutationFn: (input: unknown) => {
            mocks.calls.push("resolveScanStrays");
            return mocks.resolveStrays(input);
          },
        }),
      },
    },
  }),
}));

vi.mock("~/entities/entity-detail", () => ({
  entityDetailQueryOptions: (_entity: string, shortcode: string) => ({
    queryKey: [["location", "detail"], { shortcode }],
    queryFn: () => mocks.locations.get(shortcode) ?? null,
  }),
}));

import { useLocationSweep } from "./useLocationSweep";

// Home > Garage > Shelf A, so Garage is a genuine ancestor of the swept shelf
// and Bin 9 (also in the Garage) is a sibling that can be brought in.
const HOME = { id: "LOC-HME3", name: "Home", type: "house", children: [] };
const GARAGE = { id: "LOC-GRG4", name: "Garage", type: "room", parent: HOME };
const SHELF = {
  id: "LOC-SHF2",
  name: "Shelf A",
  type: "shelf",
  parent: GARAGE,
  children: [] as unknown[],
};
const STRAY_BIN = {
  id: "LOC-BN99",
  name: "Bin 9",
  type: "box",
  parent: GARAGE,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const render = (locationId = "LOC-SHF2") =>
  renderHook(
    (props: { locationId: string }) =>
      useLocationSweep({
        locationId: unsafeLocationShortcode(props.locationId),
        onSettled: () => {},
      }),
    { wrapper, initialProps: { locationId } },
  );

beforeEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();
  mocks.locations = new Map<string, unknown>([
    ["LOC-SHF2", SHELF],
    ["LOC-HME3", HOME],
    ["LOC-GRG4", GARAGE],
    ["LOC-BN99", STRAY_BIN],
  ]);
  mocks.reparent.mockResolvedValue({ updated: 1 });
  mocks.resolveStrays.mockResolvedValue({ moved: 1, skipped: [] });
});

const strayRow = (locationId: string, locationName: string) => ({
  entryId: "INV-DR55",
  location: { id: locationId, name: locationName },
  amount: { value: 1, unit: "each" },
  ambiguousQuantity: false,
});

const queueStray = (locationId: string, locationName: string) =>
  mocks.scan.mockResolvedValue({
    outcome: "queued",
    product: {
      id: "PRD-DR55",
      name: "Drill",
      created: false,
      manufacturer: "Acme",
      hasPrice: true,
    },
    strays: [strayRow(locationId, locationName)],
    sideEffects: { backgroundBatches: [] },
  });

describe("useLocationSweep bin scanning", () => {
  it("queues a bin that lives elsewhere, once per label", async () => {
    const { result } = render();

    act(() => {
      result.current.scan("LOC-BN99");
      result.current.scan("LOC-BN99");
    });

    await waitFor(() => expect(result.current.bins).toHaveLength(1));
    expect(result.current.bins[0]).toMatchObject({
      id: "LOC-BN99",
      name: "Bin 9",
      currentParentName: "Garage",
    });
  });

  it("confirms a direct child without queueing or writing anything", async () => {
    mocks.locations.set("LOC-BN22", {
      id: "LOC-BN22",
      name: "Bin 1",
      type: "box",
      parent: SHELF,
    });
    const { result } = render();

    act(() => result.current.scan("LOC-BN22"));

    await waitFor(() => expect(result.current.tally.confirmed).toBe(1));
    expect(result.current.bins).toHaveLength(0);
    expect(mocks.calls).toEqual([]);
  });

  it.each([
    ["Home", "LOC-HME3", "holds the whole house"],
    ["an ancestor", "LOC-GRG4", "can't move inside it"],
    ["the shelf being swept", "LOC-SHF2", "the one you're sweeping"],
  ])("refuses %s rather than queueing a cycle", async (_label, code, said) => {
    const { result } = render();

    act(() => result.current.scan(code));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining(said),
      ),
    );
    expect(result.current.bins).toHaveLength(0);
  });
});

describe("useLocationSweep commit", () => {
  it("moves bins before items, so an adopted bin is not emptied", async () => {
    queueStray("LOC-BN99", "Bin 9");
    const { result } = render();

    act(() => result.current.scan("PRD-DR55"));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan("LOC-BN99"));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: Awaited<ReturnType<typeof result.current.commitQueued>>;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    // The drill travelled in with Bin 9; moving it too would leave the bin we
    // just adopted empty.
    expect(mocks.calls).toEqual(["bulkUpdateParent"]);
    // ...and the queue still empties. Left behind, the row would survive a
    // successful commit, and the next click — with no adopted bins left to
    // filter against — would pull it out of the bin.
    expect(result.current.strays).toHaveLength(0);
    expect(result.current.bins).toHaveLength(0);
    expect(outcome!.keptInAdoptedBin).toBe(1);
    expect(outcome!.bins.moved).toBe(1);
  });

  it("still moves an item whose bin was not adopted", async () => {
    queueStray("LOC-GRG4", "Garage");
    const { result } = render();

    act(() => result.current.scan("PRD-DR55"));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan("LOC-BN99"));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    await act(async () => {
      await result.current.commitQueued({});
    });

    expect(mocks.calls).toEqual(["bulkUpdateParent", "resolveScanStrays"]);
  });

  it("aborts the whole commit when bins fail, leaving both queues intact", async () => {
    queueStray("LOC-GRG4", "Garage");
    mocks.reparent.mockRejectedValue(new Error("cycle"));
    const { result } = render();

    act(() => result.current.scan("PRD-DR55"));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan("LOC-BN99"));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: Awaited<ReturnType<typeof result.current.commitQueued>>;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    expect(outcome!.failed).toBe("bins");
    expect(mocks.calls).toEqual(["bulkUpdateParent"]);
    expect(result.current.bins).toHaveLength(1);
    expect(result.current.strays).toHaveLength(1);
  });

  it("banks the bin count when only the item half fails", async () => {
    queueStray("LOC-GRG4", "Garage");
    mocks.resolveStrays.mockRejectedValue(new Error("nope"));
    const { result } = render();

    act(() => result.current.scan("PRD-DR55"));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan("LOC-BN99"));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: Awaited<ReturnType<typeof result.current.commitQueued>>;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    expect(outcome!.failed).toBe("products");
    expect(outcome!.bins.moved).toBe(1);
    expect(result.current.bins).toHaveLength(0);
    expect(result.current.strays).toHaveLength(1);
  });
});

describe("useLocationSweep anchor gate", () => {
  /**
   * The bug this exists for: `reset()` empties the queue on a location change
   * but cannot abort a lookup already in flight. Merged into the new
   * location's queue, a reparent physically misfiles a bin — and there is no
   * undo for that.
   */
  it("discards a scan that resolves after the sweep moved on", async () => {
    let release: (() => void) | undefined;
    mocks.locations.set(
      "LOC-BN99",
      new Promise((resolve) => {
        release = () => resolve(STRAY_BIN);
      }),
    );
    mocks.locations.set("LOC-NXT2", {
      id: "LOC-NXT2",
      name: "Shelf B",
      type: "shelf",
      parent: HOME,
      children: [],
    });

    const { result, rerender } = render();
    act(() => result.current.scan("LOC-BN99"));

    rerender({ locationId: "LOC-NXT2" });
    act(() => release?.());

    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(result.current.bins).toHaveLength(0);
  });
});
