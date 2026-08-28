import type {
  ResolveScanStraysOut,
  ScanAtLocationOut,
} from "@cubby/schemas/scan";
import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  type SweepCommitOutcome,
  type LocationSweepDependencies,
  type LocationSweepLocation,
  useLocationSweep,
} from "./useLocationSweep";

function requireOutcome(
  outcome: SweepCommitOutcome | undefined,
): SweepCommitOutcome {
  if (!outcome) throw new Error("commit outcome was not returned");
  return outcome;
}

/**
 * The sweep's wiring, not its arithmetic — `planSweptBin` and `resolveProductScan`
 * are unit-tested where they live. What is only observable here is the order of
 * the two commit mutations, what a failure of each leaves behind, and the
 * anchor gate that keeps a scan read at one shelf from landing on the next.
 */

const HOME_ID = testShortcode("location", "home");
const GARAGE_ID = testShortcode("location", "garage");
const SHELF_ID = testShortcode("location", "shelf-a");
const BIN_ID = testShortcode("location", "bin-9");
const NEXT_ID = testShortcode("location", "shelf-b");
const PRODUCT_ID = testShortcode("product", "drill");
const INVENTORY_ID = testShortcode("inventory", "drill");

const HOME: LocationSweepLocation = {
  id: HOME_ID,
  name: "Home",
  type: "house",
  children: [],
};
const GARAGE: LocationSweepLocation = {
  id: GARAGE_ID,
  name: "Garage",
  type: "room",
  parent: HOME,
};
const SHELF: LocationSweepLocation = {
  id: SHELF_ID,
  name: "Shelf A",
  type: "shelf",
  parent: GARAGE,
  children: [],
};
const STRAY_BIN: LocationSweepLocation = {
  id: BIN_ID,
  name: "Bin 9",
  type: "box",
  parent: GARAGE,
};

interface SweepTestState {
  locations: Map<
    string,
    LocationSweepLocation | Promise<LocationSweepLocation>
  >;
  scanResult: ScanAtLocationOut | undefined;
  calls: string[];
  errors: string[];
  successes: string[];
  reparentFailure: Error | undefined;
  resolveFailure: Error | undefined;
}

const state: SweepTestState = {
  locations: new Map(),
  scanResult: undefined,
  calls: [],
  errors: [],
  successes: [],
  reparentFailure: undefined,
  resolveFailure: undefined,
};

const dependencies: LocationSweepDependencies = {
  fetchLocation: async (id) => (await state.locations.get(id)) ?? null,
  scanAtLocation: async () => {
    if (!state.scanResult) throw new Error("scan fixture was not configured");
    return state.scanResult;
  },
  resolveScanStrays: async () => {
    state.calls.push("resolveScanStrays");
    if (state.resolveFailure) throw state.resolveFailure;
    return {
      moved: 1,
      skipped: [],
      sideEffects: { backgroundBatches: [] },
    } satisfies ResolveScanStraysOut;
  },
  bulkUpdateParent: async () => {
    state.calls.push("bulkUpdateParent");
    if (state.reparentFailure) throw state.reparentFailure;
    return { updated: 1 };
  },
  ensureGlobalUnknown: async () => HOME,
  notifyError: (message) => state.errors.push(message),
  notifySuccess: (message) => state.successes.push(message),
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const renderSweep = (locationId = SHELF_ID) =>
  renderHook(
    (props: { locationId: string }) =>
      useLocationSweep({
        locationId: testShortcode("location", props.locationId),
        onSettled: () => {},
        dependencies,
      }),
    { wrapper, initialProps: { locationId } },
  );

beforeEach(() => {
  state.calls.length = 0;
  state.errors.length = 0;
  state.successes.length = 0;
  state.scanResult = undefined;
  state.reparentFailure = undefined;
  state.resolveFailure = undefined;
  state.locations = new Map([
    [SHELF_ID, SHELF],
    [HOME_ID, HOME],
    [GARAGE_ID, GARAGE],
    [BIN_ID, STRAY_BIN],
  ]);
});

const strayRow = (locationId: string, locationName: string) => ({
  entryId: INVENTORY_ID,
  location: {
    id: testShortcode("location", locationId),
    name: locationName,
  },
  amount: { value: 1, unit: "each" },
  ambiguousQuantity: false,
});

const queueStray = (locationId: string, locationName: string) => {
  state.scanResult = {
    outcome: "queued",
    product: {
      id: PRODUCT_ID,
      name: "Drill",
      created: false,
      manufacturer: "Acme",
      hasPrice: true,
    },
    strays: [strayRow(locationId, locationName)],
    sideEffects: { backgroundBatches: [] },
  };
};

describe("useLocationSweep bin scanning", () => {
  it("queues a bin that lives elsewhere, once per label", async () => {
    const { result } = renderSweep();

    act(() => {
      result.current.scan(BIN_ID);
      result.current.scan(BIN_ID);
    });

    await waitFor(() => expect(result.current.bins).toHaveLength(1));
    expect(result.current.bins[0]).toMatchObject({
      id: BIN_ID,
      name: "Bin 9",
      currentParentName: "Garage",
    });
  });

  it("confirms a direct child without queueing or writing anything", async () => {
    const directChildId = testShortcode("location", "bin-22");
    state.locations.set(directChildId, {
      id: directChildId,
      name: "Bin 1",
      type: "box",
      parent: SHELF,
    });
    const { result } = renderSweep();

    act(() => result.current.scan(directChildId));

    await waitFor(() => expect(result.current.tally.confirmed).toBe(1));
    expect(result.current.bins).toHaveLength(0);
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["Home", HOME_ID, "holds the whole house"],
    ["an ancestor", GARAGE_ID, "can't move inside it"],
    ["the shelf being swept", SHELF_ID, "the one you're sweeping"],
  ])("refuses %s rather than queueing a cycle", async (_label, code, said) => {
    const { result } = renderSweep();

    act(() => result.current.scan(code));

    await waitFor(() =>
      expect(state.errors.some((message) => message.includes(said))).toBe(true),
    );
    expect(result.current.bins).toHaveLength(0);
  });
});

describe("useLocationSweep commit", () => {
  it("moves bins before items, so an adopted bin is not emptied", async () => {
    queueStray(BIN_ID, "Bin 9");
    const { result } = renderSweep();

    act(() => result.current.scan(PRODUCT_ID));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan(BIN_ID));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: SweepCommitOutcome | undefined;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    expect(state.calls).toEqual(["bulkUpdateParent"]);
    expect(result.current.strays).toHaveLength(0);
    expect(result.current.bins).toHaveLength(0);
    const completed = requireOutcome(outcome);
    expect(completed.keptInAdoptedBin).toBe(1);
    expect(completed.bins.moved).toBe(1);
  });

  it("still moves an item whose bin was not adopted", async () => {
    queueStray(GARAGE_ID, "Garage");
    const { result } = renderSweep();

    act(() => result.current.scan(PRODUCT_ID));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan(BIN_ID));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    await act(async () => {
      await result.current.commitQueued({});
    });

    expect(state.calls).toEqual(["bulkUpdateParent", "resolveScanStrays"]);
  });

  it("aborts the whole commit when bins fail, leaving both queues intact", async () => {
    queueStray(GARAGE_ID, "Garage");
    state.reparentFailure = new Error("cycle");
    const { result } = renderSweep();

    act(() => result.current.scan(PRODUCT_ID));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan(BIN_ID));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: SweepCommitOutcome | undefined;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    const completed = requireOutcome(outcome);
    expect(completed.failed).toBe("bins");
    expect(state.calls).toEqual(["bulkUpdateParent"]);
    expect(result.current.bins).toHaveLength(1);
    expect(result.current.strays).toHaveLength(1);
  });

  it("banks the bin count when only the item half fails", async () => {
    queueStray(GARAGE_ID, "Garage");
    state.resolveFailure = new Error("nope");
    const { result } = renderSweep();

    act(() => result.current.scan(PRODUCT_ID));
    await waitFor(() => expect(result.current.strays).toHaveLength(1));
    act(() => result.current.scan(BIN_ID));
    await waitFor(() => expect(result.current.bins).toHaveLength(1));

    let outcome: SweepCommitOutcome | undefined;
    await act(async () => {
      outcome = await result.current.commitQueued({});
    });

    const completed = requireOutcome(outcome);
    expect(completed.failed).toBe("products");
    expect(completed.bins.moved).toBe(1);
    expect(result.current.bins).toHaveLength(0);
    expect(result.current.strays).toHaveLength(1);
  });
});

describe("useLocationSweep anchor gate", () => {
  it("discards a scan that resolves after the sweep moved on", async () => {
    let release: (() => void) | undefined;
    state.locations.set(
      BIN_ID,
      new Promise((resolve) => {
        release = () => resolve(STRAY_BIN);
      }),
    );
    state.locations.set(NEXT_ID, {
      id: NEXT_ID,
      name: "Shelf B",
      type: "shelf",
      parent: HOME,
      children: [],
    });

    const { result, rerender } = renderSweep();
    act(() => result.current.scan(BIN_ID));

    rerender({ locationId: NEXT_ID });
    act(() => release?.());

    await waitFor(() => expect(result.current.pending).toBe(0));
    expect(result.current.bins).toHaveLength(0);
  });
});
