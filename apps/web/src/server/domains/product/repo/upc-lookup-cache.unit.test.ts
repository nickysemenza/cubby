import { describe, expect, it } from "vitest";

import type { UPCLookupResponse } from "~/contracts/upc.schemas";
import type { Database } from "~/server/db";

import {
  readCachedUpcLookups,
  UpcBatchDeferredError,
  UpcLookupUnavailableError,
  type UpcLookupCacheStore,
} from "./upc-lookup-cache";

const response = (upc: string): UPCLookupResponse => ({
  upc,
  name: "Synthetic item",
  manufacturer: null,
  brand: null,
  category: null,
  description: null,
  priceDollars: null,
  imageUrl: null,
  source: "upcitemdb",
  cached: false,
});

describe("readCachedUpcLookups", () => {
  it("records completed UPCs and leaves budget-deferred UPCs unresolved", async () => {
    const upcs = Array.from({ length: 26 }, (_, index) => `upc-${index}`);
    const completedUpcs = upcs.slice(0, 25);
    const hit = response(upcs[0]!);
    const writes: Array<Parameters<UpcLookupCacheStore["record"]>> = [];
    const store: UpcLookupCacheStore = {
      getRows: async () => [],
      record: async (...args: Parameters<UpcLookupCacheStore["record"]>) => {
        writes.push(args);
      },
    };

    const result = await readCachedUpcLookups(
      {} as Database,
      upcs,
      async () => {
        throw new UpcBatchDeferredError(
          new Error("pass budget reached"),
          completedUpcs,
          new Map([[hit.upc, hit]]),
          upcs.slice(25),
        );
      },
      store,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual(completedUpcs);
    expect(writes[0]?.[1]).toEqual(new Map([[hit.upc, hit]]));
    expect(writes[0]?.[2]).toBeInstanceOf(Date);
    expect(result.lookups.get(hit.upc)).toMatchObject({
      upc: hit.upc,
      name: hit.name,
      cached: true,
    });
    expect(result.freshness).toMatchObject({
      status: "stale",
      unavailableCount: 1,
    });
  });

  it("reports unavailable when upstream is disabled and nothing is cached", async () => {
    const writes: unknown[] = [];
    const store: UpcLookupCacheStore = {
      getRows: async () => [],
      record: async (...args) => {
        writes.push(args);
      },
    };

    const result = await readCachedUpcLookups(
      {} as Database,
      ["upc-1"],
      async () => {
        throw new UpcLookupUnavailableError(["upc-1"]);
      },
      store,
    );

    expect(writes).toEqual([]);
    expect(result.lookups).toEqual(new Map());
    expect(result.freshness).toMatchObject({
      status: "unavailable",
      unavailableCount: 1,
    });
  });
});
