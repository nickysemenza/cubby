import { describe, expect, it } from "vitest";
import type { ExternalLookupResult } from "../api";
import type { Product } from "../db/schema";
import {
  resolveProductOutcomeWithDependencies,
  type ProductResolutionDependencies,
} from "./products";

type ResolverHarnessState = {
  productReads: Array<Product | undefined>;
  products: Map<string, Product>;
  freshMisses: Set<string>;
  externalResult: ExternalLookupResult;
  createdProduct: Product | undefined;
  calls: {
    lookup: string[];
    getFreshMisses: string[][];
    recordMiss: string[];
    deleteMiss: string[];
    createResolvedProduct: string[];
    cleanupImageVariants: string[];
  };
};

const aProduct: Product = {
  upc: "012345678905",
  name: "Test Product",
  manufacturer: null,
  brand: "Acme",
  category: null,
  description: null,
  priceDollars: 4.99,
  imageKey: null,
  source: "upcitemdb",
  sourceData: null,
  createdAt: "2026-06-14 00:00:00",
  updatedAt: "2026-06-14 00:00:00",
};

function createResolverHarness() {
  const state: ResolverHarnessState = {
    productReads: [],
    products: new Map<string, Product>(),
    freshMisses: new Set<string>(),
    externalResult: { status: "not_found" },
    createdProduct: undefined,
    calls: {
      lookup: [],
      getFreshMisses: [],
      recordMiss: [],
      deleteMiss: [],
      createResolvedProduct: [],
      cleanupImageVariants: [],
    },
  };

  const dependencies: ProductResolutionDependencies = {
    getProduct: async (upc) => {
      state.calls.lookup.push(`getProduct:${upc}`);
      return state.productReads.length > 0
        ? state.productReads.shift()
        : state.products.get(upc);
    },
    getFreshMisses: async (upcs) => {
      state.calls.getFreshMisses.push(upcs);
      return state.freshMisses;
    },
    recordMiss: async (upc) => {
      state.calls.recordMiss.push(upc);
      state.freshMisses.add(upc);
    },
    deleteMiss: async (upc) => {
      state.calls.deleteMiss.push(upc);
      state.freshMisses.delete(upc);
    },
    lookupExternalProduct: async (upc) => {
      state.calls.lookup.push(`external:${upc}`);
      return state.externalResult;
    },
    storeImage: async () => null,
    createResolvedProduct: async (values) => {
      state.calls.createResolvedProduct.push(values.upc);
      return state.createdProduct;
    },
    cleanupImageVariants: async (upc) => {
      state.calls.cleanupImageVariants.push(upc);
    },
  };

  return { dependencies, state };
}

describe("resolveProductOutcome", () => {
  it("returns the cached product without an external call", async () => {
    const { dependencies, state } = createResolverHarness();
    state.products.set(aProduct.upc, aProduct);

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      aProduct.upc,
    );

    expect(outcome).toEqual({
      status: "found",
      product: aProduct,
      cached: true,
    });
    expect(state.calls.lookup).toEqual([`getProduct:${aProduct.upc}`]);
    expect(state.calls.getFreshMisses).toEqual([]);
  });

  it("skips the external call when there is a fresh miss", async () => {
    const { dependencies, state } = createResolverHarness();
    state.freshMisses.add("012345678905");

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      "012345678905",
    );

    expect(outcome).toEqual({ status: "not_found" });
    expect(state.calls.lookup).toEqual(["getProduct:012345678905"]);
    expect(state.calls.recordMiss).toEqual([]);
  });

  it("force bypasses the fresh-miss guard and re-hits the API", async () => {
    const { dependencies, state } = createResolverHarness();
    // A fresh miss exists, but force must ignore it and call the API anyway.
    state.freshMisses.add("012345678905");
    state.externalResult = { status: "not_found" };

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      "012345678905",
      { force: true },
    );

    expect(outcome).toEqual({ status: "not_found" });
    expect(state.calls.getFreshMisses).toEqual([]);
    expect(state.calls.lookup).toEqual([
      "getProduct:012345678905",
      "external:012345678905",
    ]);
    expect(state.calls.recordMiss).toEqual(["012345678905"]);
  });

  it("records a miss on a definitive not-found", async () => {
    const { dependencies, state } = createResolverHarness();
    state.externalResult = { status: "not_found" };

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      "012345678905",
    );

    expect(outcome).toEqual({ status: "not_found" });
    expect(state.calls.recordMiss).toEqual(["012345678905"]);
  });

  it("does NOT record a miss on a transient error", async () => {
    const { dependencies, state } = createResolverHarness();
    state.externalResult = { status: "error" };

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      "012345678905",
    );

    expect(outcome).toEqual({ status: "error" });
    expect(state.calls.recordMiss).toEqual([]);
    expect(state.calls.createResolvedProduct).toEqual([]);
  });

  it("creates the product and clears any miss on a hit", async () => {
    const { dependencies, state } = createResolverHarness();
    state.externalResult = {
      status: "found",
      data: {
        name: "Test Product",
        manufacturer: null,
        brand: "Acme",
        category: null,
        description: null,
        priceDollars: 4.99,
        imageUrl: null,
        source: "upcitemdb",
        sourceData: "{}",
      },
    };
    state.createdProduct = aProduct;

    const outcome = await resolveProductOutcomeWithDependencies(
      dependencies,
      "012345678905",
    );

    expect(outcome).toEqual({
      status: "found",
      product: aProduct,
      cached: false,
    });
    expect(state.calls.createResolvedProduct).toEqual(["012345678905"]);
    expect(state.calls.deleteMiss).toEqual(["012345678905"]);
    expect(state.calls.recordMiss).toEqual([]);
  });

  it("returns the concurrently cached winner when its cache fill loses", async () => {
    const { dependencies, state } = createResolverHarness();
    state.productReads = [undefined, aProduct];
    state.externalResult = {
      status: "found",
      data: {
        name: "Test Product",
        manufacturer: null,
        brand: "Acme",
        category: null,
        description: null,
        priceDollars: 4.99,
        imageUrl: null,
        source: "upcitemdb",
        sourceData: "{}",
      },
    };

    await expect(
      resolveProductOutcomeWithDependencies(dependencies, aProduct.upc),
    ).resolves.toEqual({
      status: "found",
      product: aProduct,
      cached: true,
    });
    expect(state.calls.deleteMiss).toEqual([]);
    expect(state.calls.cleanupImageVariants).toEqual([aProduct.upc]);
  });
});
