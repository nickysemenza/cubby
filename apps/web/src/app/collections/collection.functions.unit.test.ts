import { describe, expect, it } from "vitest";
import {
  collectionCreateMutationOptions,
  collectionDetailQueryOptions,
  collectionDetailRootKey,
  collectionListQueryOptions,
  collectionListRootKey,
  collectionMatrixQueryOptions,
  collectionMatrixRootKey,
  collectionSetMutationOptions,
} from "./collection.functions";

describe("Collection Start operations", () => {
  it("preserves the Collection query-key roots", () => {
    expect(collectionListRootKey()).toEqual([
      ["collection", "list"],
      { type: "query" },
    ]);
    expect(collectionDetailRootKey()).toEqual([
      ["collection", "detail"],
      { type: "query" },
    ]);
    expect(collectionMatrixRootKey()).toEqual([
      ["collection", "matrix"],
      { type: "query" },
    ]);

    expect(collectionListQueryOptions().queryKey).toEqual([
      ["collection", "list"],
      { type: "query" },
    ]);
    expect(
      collectionDetailQueryOptions({
        collection: "painting",
        pagination: { pageIndex: 0, pageSize: 50 },
      }).queryKey,
    ).toEqual([
      ["collection", "detail"],
      {
        input: {
          collection: "painting",
          pagination: { pageIndex: 0, pageSize: 50 },
        },
        type: "query",
      },
    ]);
    expect(
      collectionMatrixQueryOptions({
        subject: "product",
        sort: "name-asc",
        pagination: { pageIndex: 0, pageSize: 100 },
      }).queryKey,
    ).toEqual([
      ["collection", "matrix"],
      {
        input: {
          subject: "product",
          sort: "name-asc",
          pagination: { pageIndex: 0, pageSize: 100 },
        },
        type: "query",
      },
    ]);
  });

  it("labels every helper as an observed Start operation", () => {
    const helpers = [
      collectionListQueryOptions(),
      collectionDetailQueryOptions({ collection: "painting" }),
      collectionMatrixQueryOptions({ subject: "location" }),
      collectionSetMutationOptions(),
      collectionCreateMutationOptions(),
    ];

    expect(helpers.map((helper) => helper.meta)).toEqual([
      expect.objectContaining({
        transport: "start",
        operation: "collection.list",
        observedByTransport: true,
      }),
      expect.objectContaining({
        transport: "start",
        operation: "collection.detail",
        observedByTransport: true,
      }),
      expect.objectContaining({
        transport: "start",
        operation: "collection.matrix",
        observedByTransport: true,
      }),
      expect.objectContaining({
        transport: "start",
        operation: "collection.set",
        observedByTransport: true,
      }),
      expect.objectContaining({
        transport: "start",
        operation: "collection.create",
        observedByTransport: true,
      }),
    ]);
  });
});
