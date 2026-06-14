import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock every dependency so we can assert resolveProductOutcome's branching
// (the negative-caching rules) without a real D1 database.
vi.mock("../db/products", () => ({
  getProduct: vi.fn(),
  createProduct: vi.fn(),
}));
vi.mock("../db/misses", () => ({
  getFreshMisses: vi.fn(),
  recordMiss: vi.fn(),
  deleteMiss: vi.fn(),
}));
vi.mock("../api", () => ({ lookupExternalProduct: vi.fn() }));
vi.mock("../storage/images", () => ({ storeImage: vi.fn() }));

import { lookupExternalProduct } from "../api";
import { createProduct, getProduct } from "../db/products";
import { deleteMiss, getFreshMisses, recordMiss } from "../db/misses";
import type { Database } from "../db";
import type { Env } from "../types";
import type { Product } from "../db/schema";
import { resolveProductOutcome } from "./products";

const db = {} as Database;
const env = {} as Env;

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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFreshMisses).mockResolvedValue(new Set());
});

describe("resolveProductOutcome", () => {
  it("returns the cached product without an external call", async () => {
    vi.mocked(getProduct).mockResolvedValue(aProduct);

    const outcome = await resolveProductOutcome(db, env, aProduct.upc);

    expect(outcome).toEqual({
      status: "found",
      product: aProduct,
      cached: true,
    });
    expect(lookupExternalProduct).not.toHaveBeenCalled();
    expect(getFreshMisses).not.toHaveBeenCalled();
  });

  it("skips the external call when there is a fresh miss", async () => {
    vi.mocked(getProduct).mockResolvedValue(undefined);
    vi.mocked(getFreshMisses).mockResolvedValue(new Set(["012345678905"]));

    const outcome = await resolveProductOutcome(db, env, "012345678905");

    expect(outcome).toEqual({ status: "not_found" });
    expect(lookupExternalProduct).not.toHaveBeenCalled();
    expect(recordMiss).not.toHaveBeenCalled();
  });

  it("records a miss on a definitive not-found", async () => {
    vi.mocked(getProduct).mockResolvedValue(undefined);
    vi.mocked(lookupExternalProduct).mockResolvedValue({ status: "not_found" });

    const outcome = await resolveProductOutcome(db, env, "012345678905");

    expect(outcome).toEqual({ status: "not_found" });
    expect(recordMiss).toHaveBeenCalledWith(db, "012345678905");
  });

  it("does NOT record a miss on a transient error", async () => {
    vi.mocked(getProduct).mockResolvedValue(undefined);
    vi.mocked(lookupExternalProduct).mockResolvedValue({ status: "error" });

    const outcome = await resolveProductOutcome(db, env, "012345678905");

    expect(outcome).toEqual({ status: "error" });
    expect(recordMiss).not.toHaveBeenCalled();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("creates the product and clears any miss on a hit", async () => {
    vi.mocked(getProduct).mockResolvedValue(undefined);
    vi.mocked(lookupExternalProduct).mockResolvedValue({
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
    });
    vi.mocked(createProduct).mockResolvedValue(aProduct);

    const outcome = await resolveProductOutcome(db, env, "012345678905");

    expect(outcome).toEqual({
      status: "found",
      product: aProduct,
      cached: false,
    });
    expect(createProduct).toHaveBeenCalledOnce();
    expect(deleteMiss).toHaveBeenCalledWith(db, "012345678905");
    expect(recordMiss).not.toHaveBeenCalled();
  });
});
