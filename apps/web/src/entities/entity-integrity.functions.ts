import {
  type IntegrityCatalog,
  integrityCatalogSchema,
  referentialLivenessViolationSchema,
} from "@cubby/schemas/entity-integrity";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as problemsBrowser from "~/server/problems-browser.server";

const REFERENTIAL_LIVENESS_INPUT = {
  key: "referentialLivenessViolations",
} as const;
const referentialLivenessResultSchema = z.object({
  type: z.literal("referentialLivenessViolations"),
  items: z.array(referentialLivenessViolationSchema),
  total: z.number().int().nonnegative(),
});

const getEntityIntegrityCatalogTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await entityRuntime.getEntityIntegrityCatalog({
        request: context.startOperation,
      }),
  );

const getReferentialLivenessTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as typeof REFERENTIAL_LIVENESS_INPUT)
  .handler(
    async ({ data, context }) =>
      await problemsBrowser.getProblemByType({
        data,
        request: context.startOperation,
      }),
  );

const integrityCatalogOperation = startOperation<null, IntegrityCatalog>({
  operation: "entityIntegrity.catalog",
  transport: (_input, { signal, headers }) =>
    getEntityIntegrityCatalogTransport({ signal, headers }),
  parse: (result) => integrityCatalogSchema.parse(result),
});

const referentialLivenessOperation = startOperation<
  typeof REFERENTIAL_LIVENESS_INPUT,
  z.output<typeof referentialLivenessResultSchema>
>({
  operation: "problems.getByType",
  transport: (data, { signal, headers }) =>
    getReferentialLivenessTransport({ data, signal, headers }),
  parse: (result) => referentialLivenessResultSchema.parse(result),
});

export const entityIntegrityCatalogQueryOptions = () =>
  queryOptions({
    queryKey: [["entityIntegrity", "catalog"]] as const,
    meta: integrityCatalogOperation.meta,
    queryFn: ({ signal }) => integrityCatalogOperation.call(null, { signal }),
  });

export const referentialLivenessQueryOptions = () =>
  queryOptions({
    queryKey: [["problems", "getByType"], REFERENTIAL_LIVENESS_INPUT] as const,
    meta: referentialLivenessOperation.meta,
    queryFn: ({ signal }) =>
      referentialLivenessOperation.call(REFERENTIAL_LIVENESS_INPUT, { signal }),
  });
