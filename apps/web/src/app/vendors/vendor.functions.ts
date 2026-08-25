import {
  type fetchVendorLogoInput,
  type mergeVendorsInput,
  mergeVendorsOut,
  vendorOptionsOut,
  vendorOut,
} from "@cubby/schemas/vendor";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as vendorBrowser from "~/server/vendor-browser.server";

const optionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    vendorBrowser.vendorOptionsForBrowser({ request: context.startOperation }),
  );
const mergeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof mergeVendorsInput>)
  .handler(({ data, context }) =>
    vendorBrowser.mergeVendorsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const fetchLogoTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof fetchVendorLogoInput>)
  .handler(({ data, context }) =>
    vendorBrowser.fetchVendorLogoForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const optionsOperation = startOperation<
  null,
  z.output<typeof vendorOptionsOut>
>({
  operation: "vendor.options",
  transport: (_input, { signal, headers }) =>
    optionsTransport({ signal, headers }),
  parse: (value) => vendorOptionsOut.parse(value),
});
const mergeOperation = startOperation<
  z.input<typeof mergeVendorsInput>,
  z.output<typeof mergeVendorsOut>
>({
  operation: "vendor.merge",
  kind: "mutation",
  transport: (data, { headers }) => mergeTransport({ data, headers }),
  parse: (value) => mergeVendorsOut.parse(value),
});
const fetchLogoOperation = startOperation<
  z.input<typeof fetchVendorLogoInput>,
  z.output<typeof vendorOut>
>({
  operation: "vendor.fetchLogo",
  kind: "mutation",
  transport: (data, { headers }) => fetchLogoTransport({ data, headers }),
  parse: (value) => vendorOut.parse(value),
});

export const vendorOptionsQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.vendor.all, "options"]] as const,
    meta: optionsOperation.meta,
    queryFn: ({ signal }) => optionsOperation.call(null, { signal }),
  });

export const mergeVendorsMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.vendor.all, "merge"] as const,
    meta: mergeOperation.meta,
    mutationFn: async (input: z.input<typeof mergeVendorsInput>) => {
      const result = await mergeOperation.call(input);
      return result;
    },
  });

export const fetchVendorLogoMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.vendor.all, "fetchLogo"] as const,
    meta: fetchLogoOperation.meta,
    mutationFn: async (input: z.input<typeof fetchVendorLogoInput>) => {
      const result = await fetchLogoOperation.call(input);
      return result;
    },
  });
