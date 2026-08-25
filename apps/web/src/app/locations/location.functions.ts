import {
  infLocation,
  infLocationListOut,
  type locationBulkUpdateParentInput,
  locationBulkUpdateParentOut,
  locationFiltersSchema,
  locationInventoryBreakdownOut,
  locationParentOptionsOut,
  locationPickerItemOut,
  type locationShortcodesInput,
  locationsWithParentNameOut,
  locationValuationSummaryOut,
} from "@cubby/schemas/location";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import * as browser from "~/server/location-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const treeTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) => browser.makeTreeForBrowser(context.startOperation));
const tree = startOperation<null, z.output<typeof infLocationListOut>>({
  operation: "location.makeTree",
  transport: (_i, o) => treeTransport(o),
  parse: (r) => infLocationListOut.parse(r),
});
export const locationTreeQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "makeTree"] as const,
    meta: tree.meta,
    queryFn: ({ signal }) => tree.call(null, { signal }),
  });
const valuationTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.valuationSummaryForBrowser(context.startOperation),
  );
const valuation = startOperation<
  null,
  z.output<typeof locationValuationSummaryOut>
>({
  operation: "location.valuationSummary",
  transport: (_i, o) => valuationTransport(o),
  parse: (r) => locationValuationSummaryOut.parse(r),
});
export const locationValuationSummaryQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "valuationSummary"] as const,
    meta: valuation.meta,
    queryFn: ({ signal }) => valuation.call(null, { signal }),
  });

const ensureTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.ensureGlobalUnknownForBrowser(context.startOperation),
  );
const ensureOp = startOperation<null, z.output<typeof infLocation>>({
  operation: "location.ensureGlobalUnknown",
  kind: "mutation",
  transport: (_i, o) => ensureTransport(o),
  parse: (r) => infLocation.parse(r),
});
export const ensureGlobalUnknownMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.location.all, "ensureGlobalUnknown"],
    mutationFn: async () => {
      const result = await ensureOp.call(null);
      markFreshReads();
      return result;
    },
    meta: ensureOp.meta,
  });
const bulkTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof locationBulkUpdateParentInput>,
  )
  .handler(({ data, context }) =>
    browser.bulkUpdateParentForBrowser(data, context.startOperation),
  );
const bulkOp = startOperation<
  z.input<typeof locationBulkUpdateParentInput>,
  z.output<typeof locationBulkUpdateParentOut>
>({
  operation: "location.bulkUpdateParent",
  kind: "mutation",
  transport: (data, o) => bulkTransport({ data, ...o }),
  parse: (r) => locationBulkUpdateParentOut.parse(r),
});
export const bulkUpdateParentMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.location.all, "bulkUpdateParent"],
    mutationFn: async (data: z.input<typeof locationBulkUpdateParentInput>) => {
      const result = await bulkOp.call(data);
      markFreshReads();
      return result;
    },
    meta: bulkOp.meta,
  });
const shortcodesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof locationShortcodesInput>,
  )
  .handler(({ data, context }) =>
    browser.getByShortcodesForBrowser(data, context.startOperation),
  );
const shortcodesOp = startOperation<
  z.input<typeof locationShortcodesInput>,
  z.output<typeof locationsWithParentNameOut>
>({
  operation: "location.getByShortcodes",
  transport: (data, o) => shortcodesTransport({ data, ...o }),
  parse: (r) => locationsWithParentNameOut.parse(r),
});
export const locationShortcodesQueryOptions = (
  data: z.input<typeof locationShortcodesInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "getByShortcodes", data] as const,
    meta: shortcodesOp.meta,
    queryFn: ({ signal }) => shortcodesOp.call(data, { signal }),
  });
const recomputeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.recomputeValuationsForBrowser(context.startOperation),
  );
const recomputeOp = startOperation<null, { updated: number }>({
  operation: "location.recomputeValuations",
  kind: "mutation",
  transport: (_i, o) => recomputeTransport(o),
  parse: (r) => z.object({ updated: z.number() }).parse(r),
});
export const recomputeValuationsMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.location.all, "recomputeValuations"],
    mutationFn: async () => {
      const result = await recomputeOp.call(null);
      markFreshReads();
      return result;
    },
    meta: recomputeOp.meta,
  });
export const recomputeLocationValuations = async () => {
  const result = await recomputeOp.call(null);
  markFreshReads();
  return result;
};

const rosterInput = z.object({
  filters: locationFiltersSchema,
  sort: z.object({ orderBy: z.string(), direction: z.enum(["asc", "desc"]) }),
  pagination: z.object({ pageIndex: z.number(), pageSize: z.number() }),
});
const searchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof rosterInput>)
  .handler(({ data, context }) =>
    browser.searchForBrowser(data, context.startOperation),
  );
const searchOp = startOperation<
  z.input<typeof rosterInput>,
  { data: z.output<typeof locationPickerItemOut>[]; count: number }
>({
  operation: "location.search",
  transport: (data, o) => searchTransport({ data, ...o }),
  parse: (r) =>
    z
      .object({ data: z.array(locationPickerItemOut), count: z.number() })
      .parse(r),
});
export const locationSearchQueryOptions = (data: z.input<typeof rosterInput>) =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "search", data] as const,
    meta: searchOp.meta,
    queryFn: async ({ signal }) => {
      const result = await searchOp.call(data, { signal });
      return { ...result, items: result.data };
    },
  });
const subtreeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as { shortcode: string })
  .handler(({ data, context }) =>
    browser.subtreeForBrowser(data, context.startOperation),
  );
const subtreeOp = startOperation<
  { shortcode: string },
  z.output<typeof infLocationListOut>
>({
  operation: "location.subtree",
  transport: (data, o) => subtreeTransport({ data, ...o }),
  parse: (r) => infLocationListOut.parse(r),
});
export const locationSubtreeQueryOptions = (
  data: { shortcode: string },
  options?: { enabled?: boolean },
) =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "subtree", data] as const,
    ...options,
    meta: subtreeOp.meta,
    queryFn: ({ signal }) => subtreeOp.call(data, { signal }),
  });
const breakdownTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as { shortcode: string })
  .handler(({ data, context }) =>
    browser.inventoryBreakdownForBrowser(data, context.startOperation),
  );
const breakdownOp = startOperation<
  { shortcode: string },
  z.output<typeof locationInventoryBreakdownOut> | null
>({
  operation: "location.inventoryBreakdown",
  transport: (data, o) => breakdownTransport({ data, ...o }),
  parse: (r) => locationInventoryBreakdownOut.nullable().parse(r),
});
export const locationInventoryBreakdownQueryOptions = (
  data: { shortcode: string },
  options?: { enabled?: boolean },
) =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "inventoryBreakdown", data] as const,
    ...options,
    meta: breakdownOp.meta,
    queryFn: ({ signal }) => breakdownOp.call(data, { signal }),
  });
const parentTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.parentOptionsForBrowser(context.startOperation),
  );
const parentOp = startOperation<
  null,
  z.output<typeof locationParentOptionsOut>[]
>({
  operation: "location.parentOptions",
  transport: (_i, o) => parentTransport(o),
  parse: (r) => z.array(locationParentOptionsOut).parse(r),
});
export const locationParentOptionsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.location.all, "parentOptions"] as const,
    meta: parentOp.meta,
    queryFn: ({ signal }) => parentOp.call(null, { signal }),
  });
