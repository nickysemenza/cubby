import {
  integrityCatalogSchema,
  referentialLivenessViolationSchema,
} from "@cubby/schemas/entity-integrity";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
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

export const entityIntegrityCatalogQueryOptions = () =>
  queryOptions({
    queryKey: [["entityIntegrity", "catalog"]] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "entityIntegrity.catalog",
        input: null,
        call: async (headers) =>
          integrityCatalogSchema.parse(
            unwrapStartOperationResult(
              "entityIntegrity.catalog",
              await getEntityIntegrityCatalogTransport({ signal, headers }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "entityIntegrity.catalog",
      observedByTransport: true,
    },
  });

export const referentialLivenessQueryOptions = () =>
  queryOptions({
    queryKey: [["problems", "getByType"], REFERENTIAL_LIVENESS_INPUT] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "problems.getByType",
        input: REFERENTIAL_LIVENESS_INPUT,
        call: async (headers) =>
          referentialLivenessResultSchema.parse(
            unwrapStartOperationResult(
              "problems.getByType",
              await getReferentialLivenessTransport({
                data: REFERENTIAL_LIVENESS_INPUT,
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "problems.getByType",
      observedByTransport: true,
    },
  });
