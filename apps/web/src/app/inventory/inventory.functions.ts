import {
  type bulkMovePayload,
  type inventoryBulkOperationPayload,
  inventoryDuplicateUniqueProductsOut,
  type inventoryFindDuplicatesInput,
  type inventoryLocationIdsInput,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  inventoryWithLocationAndProductListOut,
  type moveInventoryEntriesPayload,
  type reconcileSessionPayload,
} from "@cubby/schemas/inventory";
import {
  type resolveScanStraysInput,
  resolveScanStraysOut,
  type scanAtLocationInput,
  scanAtLocationOut,
} from "@cubby/schemas/scan";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import * as inventoryBrowser from "~/server/inventory-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const bulkProcessTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof inventoryBulkOperationPayload>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.bulkProcessInventoryForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const bulkMoveTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof bulkMovePayload>)
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.bulkMoveInventoryForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const moveEntriesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof moveInventoryEntriesPayload>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.moveInventoryEntriesForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const reconcileSessionTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof reconcileSessionPayload>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.reconcileInventorySessionForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const scanAtLocationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof scanAtLocationInput>)
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.scanInventoryAtLocationForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const resolveScanStraysTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof resolveScanStraysInput>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.resolveInventoryScanStraysForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const findDuplicatesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof inventoryFindDuplicatesInput>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.findInventoryDuplicatesForBrowser({
        data,
        request: context.startOperation,
      }),
  );
const byLocationIdsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof inventoryLocationIdsInput>,
  )
  .handler(
    async ({ data, context }) =>
      await inventoryBrowser.getInventoryByLocationIdsForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const bulkProcessOperation = startOperation<
  z.input<typeof inventoryBulkOperationPayload>,
  z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>
>({
  operation: "inventory.bulkProcess",
  kind: "mutation",
  transport: (data, { headers }) => bulkProcessTransport({ data, headers }),
  parse: (result) =>
    inventoryWithLocationAndProductListAndSideEffectsOut.parse(result),
});
const bulkMoveOperation = startOperation<
  z.input<typeof bulkMovePayload>,
  z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>
>({
  operation: "inventory.bulkMove",
  kind: "mutation",
  transport: (data, { headers }) => bulkMoveTransport({ data, headers }),
  parse: (result) =>
    inventoryWithLocationAndProductListAndSideEffectsOut.parse(result),
});
const moveEntriesOperation = startOperation<
  z.input<typeof moveInventoryEntriesPayload>,
  z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>
>({
  operation: "inventory.moveEntries",
  kind: "mutation",
  transport: (data, { headers }) => moveEntriesTransport({ data, headers }),
  parse: (result) =>
    inventoryWithLocationAndProductListAndSideEffectsOut.parse(result),
});
const reconcileSessionOperation = startOperation<
  z.input<typeof reconcileSessionPayload>,
  z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>
>({
  operation: "inventory.reconcileSession",
  kind: "mutation",
  transport: (data, { headers }) =>
    reconcileSessionTransport({ data, headers }),
  parse: (result) =>
    inventoryWithLocationAndProductListAndSideEffectsOut.parse(result),
});
const scanAtLocationOperation = startOperation<
  z.input<typeof scanAtLocationInput>,
  z.output<typeof scanAtLocationOut>
>({
  operation: "inventory.scanAtLocation",
  kind: "mutation",
  transport: (data, { headers }) => scanAtLocationTransport({ data, headers }),
  parse: (result) => scanAtLocationOut.parse(result),
});
const resolveScanStraysOperation = startOperation<
  z.input<typeof resolveScanStraysInput>,
  z.output<typeof resolveScanStraysOut>
>({
  operation: "inventory.resolveScanStrays",
  kind: "mutation",
  transport: (data, { headers }) =>
    resolveScanStraysTransport({ data, headers }),
  parse: (result) => resolveScanStraysOut.parse(result),
});
const findDuplicatesOperation = startOperation<
  z.input<typeof inventoryFindDuplicatesInput>,
  z.output<typeof inventoryDuplicateUniqueProductsOut>
>({
  operation: "inventory.findDuplicates",
  transport: (data, { signal, headers }) =>
    findDuplicatesTransport({ data, signal, headers }),
  parse: (result) => inventoryDuplicateUniqueProductsOut.parse(result),
});
const byLocationIdsOperation = startOperation<
  z.input<typeof inventoryLocationIdsInput>,
  z.output<typeof inventoryWithLocationAndProductListOut>
>({
  operation: "inventory.getByLocationIds",
  transport: (data, { signal, headers }) =>
    byLocationIdsTransport({ data, signal, headers }),
  parse: (result) => inventoryWithLocationAndProductListOut.parse(result),
});

export const bulkProcessInventoryMutationOptions = (
  options?: Parameters<
    typeof mutationOptions<
      z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>,
      Error,
      z.input<typeof inventoryBulkOperationPayload>
    >
  >[0],
) =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "bulkProcess"] as const,
    mutationFn: async (input) => {
      const result = await bulkProcessOperation.call(input);
      return result;
    },
    meta: bulkProcessOperation.meta,
    ...options,
  });
export const bulkMoveInventoryMutationOptions = (
  options?: Parameters<
    typeof mutationOptions<
      z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>,
      Error,
      z.input<typeof bulkMovePayload>
    >
  >[0],
) =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "bulkMove"] as const,
    mutationFn: async (input) => {
      const result = await bulkMoveOperation.call(input);
      return result;
    },
    meta: bulkMoveOperation.meta,
    ...options,
  });
export const moveInventoryEntriesMutationOptions = (
  options?: Parameters<
    typeof mutationOptions<
      z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>,
      Error,
      z.input<typeof moveInventoryEntriesPayload>
    >
  >[0],
) =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "moveEntries"] as const,
    mutationFn: async (input) => {
      const result = await moveEntriesOperation.call(input);
      return result;
    },
    meta: moveEntriesOperation.meta,
    ...options,
  });
export const reconcileInventorySessionMutationOptions = (
  options?: Parameters<
    typeof mutationOptions<
      z.output<typeof inventoryWithLocationAndProductListAndSideEffectsOut>,
      Error,
      z.input<typeof reconcileSessionPayload>
    >
  >[0],
) =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "reconcileSession"] as const,
    mutationFn: async (input) => {
      const result = await reconcileSessionOperation.call(input);
      return result;
    },
    meta: reconcileSessionOperation.meta,
    ...options,
  });
export const scanInventoryAtLocationMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "scanAtLocation"] as const,
    mutationFn: async (input: z.input<typeof scanAtLocationInput>) => {
      const result = await scanAtLocationOperation.call(input);
      return result;
    },
    meta: scanAtLocationOperation.meta,
  });
export const resolveInventoryScanStraysMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.inventory.all, "resolveScanStrays"] as const,
    mutationFn: async (input: z.input<typeof resolveScanStraysInput>) => {
      const result = await resolveScanStraysOperation.call(input);
      return result;
    },
    meta: resolveScanStraysOperation.meta,
  });

export const inventoryDuplicatesQueryOptions = (
  input: z.input<typeof inventoryFindDuplicatesInput>,
) =>
  queryOptions({
    queryKey: [
      ...queryKeys.inventory.all,
      "findDuplicates",
      { input },
    ] as const,
    meta: findDuplicatesOperation.meta,
    queryFn: ({ signal }) => findDuplicatesOperation.call(input, { signal }),
  });
export const inventoryByLocationIdsQueryOptions = (
  input: z.input<typeof inventoryLocationIdsInput>,
) =>
  queryOptions({
    queryKey: [
      ...queryKeys.inventory.all,
      "getByLocationIds",
      { input },
    ] as const,
    meta: byLocationIdsOperation.meta,
    queryFn: ({ signal }) => byLocationIdsOperation.call(input, { signal }),
  });
