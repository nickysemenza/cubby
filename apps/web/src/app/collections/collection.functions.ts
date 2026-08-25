import {
  type collectionCreateInput,
  type collectionDetailInput,
  collectionDetailOut,
  type collectionMatrixInput,
  collectionMatrixOut,
  collectionSummaryOut,
  type collectionTagSetInput,
  collectionTagSetOut,
} from "@cubby/schemas/collection";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import * as collectionBrowser from "~/server/collection-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const listCollectionsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await collectionBrowser.listCollectionsForBrowser({
        request: context.startOperation,
      }),
  );

const getCollectionDetailTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof collectionDetailInput>)
  .handler(
    async ({ data, context }) =>
      await collectionBrowser.getCollectionDetailForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const getCollectionMatrixTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof collectionMatrixInput>)
  .handler(
    async ({ data, context }) =>
      await collectionBrowser.getCollectionMatrixForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const setCollectionMembershipTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof collectionTagSetInput>)
  .handler(
    async ({ data, context }) =>
      await collectionBrowser.setCollectionMembershipForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const createCollectionTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof collectionCreateInput>)
  .handler(
    async ({ data, context }) =>
      await collectionBrowser.createCollectionForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const collectionListOperation = startOperation<
  null,
  z.output<typeof collectionSummaryOut>[]
>({
  operation: "collection.list",
  transport: (_input, { signal, headers }) =>
    listCollectionsTransport({ signal, headers }),
  parse: (result) => z.array(collectionSummaryOut).parse(result),
});

const collectionDetailOperation = startOperation<
  z.input<typeof collectionDetailInput>,
  z.output<typeof collectionDetailOut>
>({
  operation: "collection.detail",
  transport: (data, { signal, headers }) =>
    getCollectionDetailTransport({ data, signal, headers }),
  parse: (result) => collectionDetailOut.parse(result),
});

const collectionMatrixOperation = startOperation<
  z.input<typeof collectionMatrixInput>,
  z.output<typeof collectionMatrixOut>
>({
  operation: "collection.matrix",
  transport: (data, { signal, headers }) =>
    getCollectionMatrixTransport({ data, signal, headers }),
  parse: (result) => collectionMatrixOut.parse(result),
});

const collectionSetOperation = startOperation<
  z.input<typeof collectionTagSetInput>,
  z.output<typeof collectionTagSetOut>
>({
  operation: "collection.set",
  kind: "mutation",
  transport: (data, { headers }) =>
    setCollectionMembershipTransport({ data, headers }),
  parse: (result) => collectionTagSetOut.parse(result),
});

const collectionCreateOperation = startOperation<
  z.input<typeof collectionCreateInput>,
  z.output<typeof collectionSummaryOut>
>({
  operation: "collection.create",
  kind: "mutation",
  transport: (data, { headers }) =>
    createCollectionTransport({ data, headers }),
  parse: (result) => collectionSummaryOut.parse(result),
});

export const collectionListRootKey = () =>
  [["collection", "list"], { type: "query" }] as const;
export const collectionDetailRootKey = () =>
  [["collection", "detail"], { type: "query" }] as const;
export const collectionMatrixRootKey = () =>
  [["collection", "matrix"], { type: "query" }] as const;

export const collectionListQueryOptions = () =>
  queryOptions({
    queryKey: collectionListRootKey(),
    meta: collectionListOperation.meta,
    queryFn: ({ signal }) => collectionListOperation.call(null, { signal }),
  });

export const collectionDetailQueryOptions = (
  input: z.input<typeof collectionDetailInput>,
) =>
  queryOptions({
    queryKey: [["collection", "detail"], { input, type: "query" }] as const,
    meta: collectionDetailOperation.meta,
    queryFn: ({ signal }) => collectionDetailOperation.call(input, { signal }),
  });

export const collectionMatrixQueryOptions = (
  input: z.input<typeof collectionMatrixInput>,
) =>
  queryOptions({
    queryKey: [["collection", "matrix"], { input, type: "query" }] as const,
    meta: collectionMatrixOperation.meta,
    queryFn: ({ signal }) => collectionMatrixOperation.call(input, { signal }),
  });

export const collectionSetMutationOptions = () =>
  mutationOptions({
    mutationKey: [["collection", "set"]] as const,
    meta: collectionSetOperation.meta,
    mutationFn: async (input: z.input<typeof collectionTagSetInput>) => {
      const result = await collectionSetOperation.call(input);
      markFreshReads();
      return result;
    },
  });

export const collectionCreateMutationOptions = () =>
  mutationOptions({
    mutationKey: [["collection", "create"]] as const,
    meta: collectionCreateOperation.meta,
    mutationFn: async (input: z.input<typeof collectionCreateInput>) => {
      const result = await collectionCreateOperation.call(input);
      markFreshReads();
      return result;
    },
  });

export type CollectionMatrixRow = z.output<
  typeof collectionMatrixOut
>["rows"][number];
