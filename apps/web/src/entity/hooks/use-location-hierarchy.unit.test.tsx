import { locationDetailOut as infLocation } from "@cubby/schemas/entities/location";
import { locationValuation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { locationReadFixture } from "~/features/location/location-read.fixtures";
import { location } from "~/integrations/tanstack-query/domains/location";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { useLocationHierarchy } from "./use-location-hierarchy";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it("retains current counts without inventing a missing valuation or pricing counts", async () => {
  const root = locationReadFixture({
    id: testShortcode("location", "LOC-2222"),
    name: "Synthetic unassessed room",
    type: "room",
    children: [],
    directItemCount: 2,
    totalItemCount: 2,
  });
  harness.queryClient.setQueryData(location.makeTree.queryKey(), [root]);
  const { result } = renderHook(() => useLocationHierarchy(), {
    wrapper: harness.wrapper,
  });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  expect(result.current.data).toMatchObject({
    directCount: 2,
    totalCount: 2,
    directValuation: null,
    totalValuation: null,
    directPricingStatus: null,
    totalPricingStatus: null,
    valuation: { result: { kind: "missing" } },
  });
});

it("keeps a real cached zero and its raw refresh failure in the hierarchy model", async () => {
  const value = locationValuation.parse({
    directValuation: 0,
    totalValuation: 0,
    directItemCount: 1,
    totalItemCount: 1,
    direct: { priced: 1, missingPricing: 0, miscNoPrice: 0 },
    total: { priced: 1, missingPricing: 0, miscNoPrice: 0 },
  });
  const error = "Synthetic SQLSTATE 40001: location valuation refresh failed";
  const valuation = infLocation.shape.fields.shape.valuation.parse({
    current: {
      assignment: null,
      controls: { kind: "readonly", reason: "computed" },
    },
    result: {
      kind: "cached",
      computedAt: "2026-10-01T00:00:00Z",
      freshness: "stale",
      decision: {
        outcome: { kind: "value", value },
        provenance: { kind: "computed" },
      },
    },
    work: { kind: "failed", error, retryAt: null },
  });
  const root = locationReadFixture({
    id: testShortcode("location", "LOC-2222"),
    name: "Synthetic zero room",
    type: "room",
    children: [],
    fields: { valuation },
  });
  harness.queryClient.setQueryData(location.makeTree.queryKey(), [root]);
  const { result } = renderHook(() => useLocationHierarchy(), {
    wrapper: harness.wrapper,
  });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  expect(result.current.data).toMatchObject({
    directValuation: 0,
    totalValuation: 0,
    totalPricingStatus: { priced: { count: 1 } },
    valuation: {
      result: { kind: "cached", freshness: "stale" },
      work: { kind: "failed", error },
    },
  });
});
