import type { productShortcode } from "@cubby/schemas/identifiers";
import {
  type dismissDuplicateProductRecommendationInput,
  type dismissProductRecommendationInput,
  type dismissTagPropagationInput,
  type duplicateProductRecommendationInput,
  duplicateProductRecommendationOut,
  type placementRecommendationInput,
  placementRecommendationOut,
  recommendationOkSchema,
  type recommendationWorkbenchInput,
  recommendationWorkbenchOut,
  type tagPropagationRecommendationInput,
  tagPropagationRecommendationOut,
} from "@cubby/schemas/recommendations";
import { relatednessOutSchema } from "@cubby/schemas/relatedness";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/recommendations-browser.server";

const relatednessTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof productShortcode>)
  .handler(({ data, context }) =>
    browser.getProductRelatednessForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const placementTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof placementRecommendationInput>)
  .handler(({ data, context }) =>
    browser.getPlacementRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const productTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof recommendationWorkbenchInput>)
  .handler(({ data, context }) =>
    browser.getProductRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const duplicateProductTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof duplicateProductRecommendationInput>,
  )
  .handler(({ data, context }) =>
    browser.getDuplicateProductRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const dismissDuplicateProductTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof dismissDuplicateProductRecommendationInput>,
  )
  .handler(({ data, context }) =>
    browser.dismissDuplicateProductRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const tagPropagationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof tagPropagationRecommendationInput>,
  )
  .handler(({ data, context }) =>
    browser.getTagPropagationRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const dismissTagPropagationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof dismissTagPropagationInput>)
  .handler(({ data, context }) =>
    browser.dismissTagPropagationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const dismissProductTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof dismissProductRecommendationInput>,
  )
  .handler(({ data, context }) =>
    browser.dismissProductRecommendationForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const relatednessOperation = startOperation({
  operation: "relatedness.product",
  transport: (data: z.input<typeof productShortcode>, { signal, headers }) =>
    relatednessTransport({ data, signal, headers }),
  parse: (result) => relatednessOutSchema.parse(result),
});
const placementOperation = startOperation({
  operation: "recommendations.placement",
  transport: (
    data: z.input<typeof placementRecommendationInput>,
    { signal, headers },
  ) => placementTransport({ data, signal, headers }),
  parse: (result) => placementRecommendationOut.parse(result),
});
const productOperation = startOperation({
  operation: "recommendations.product",
  transport: (
    data: z.input<typeof recommendationWorkbenchInput>,
    { signal, headers },
  ) => productTransport({ data, signal, headers }),
  parse: (result) => recommendationWorkbenchOut.parse(result),
});
const duplicateProductOperation = startOperation({
  operation: "recommendations.duplicateProduct",
  transport: (
    data: z.input<typeof duplicateProductRecommendationInput>,
    { signal, headers },
  ) => duplicateProductTransport({ data, signal, headers }),
  parse: (result) => duplicateProductRecommendationOut.parse(result),
});
const dismissDuplicateProductOperation = startOperation({
  operation: "recommendations.dismissDuplicateProduct",
  kind: "mutation",
  transport: (
    data: z.input<typeof dismissDuplicateProductRecommendationInput>,
    { headers },
  ) => dismissDuplicateProductTransport({ data, headers }),
  parse: (result) => recommendationOkSchema.parse(result),
});
const tagPropagationOperation = startOperation({
  operation: "recommendations.tagPropagation",
  transport: (
    data: z.input<typeof tagPropagationRecommendationInput>,
    { signal, headers },
  ) => tagPropagationTransport({ data, signal, headers }),
  parse: (result) => tagPropagationRecommendationOut.parse(result),
});
const dismissTagPropagationOperation = startOperation({
  operation: "recommendations.dismissTagPropagation",
  kind: "mutation",
  transport: (data: z.input<typeof dismissTagPropagationInput>, { headers }) =>
    dismissTagPropagationTransport({ data, headers }),
  parse: (result) => recommendationOkSchema.parse(result),
});
const dismissProductOperation = startOperation({
  operation: "recommendations.dismissProduct",
  kind: "mutation",
  transport: (
    data: z.input<typeof dismissProductRecommendationInput>,
    { headers },
  ) => dismissProductTransport({ data, headers }),
  parse: (result) => recommendationOkSchema.parse(result),
});

export const relatednessProductRootKey = () =>
  [["relatedness", "product"], { type: "query" }] as const;
export const recommendationRootKey = (name: string) =>
  [["recommendations", name], { type: "query" }] as const;
const query = <I, O>(
  root: readonly unknown[],
  input: I,
  operation: {
    meta: object;
    call(input: I, options: { signal: AbortSignal }): Promise<O>;
  },
) =>
  queryOptions({
    queryKey: [...root, { input }] as const,
    meta: operation.meta as never,
    queryFn: ({ signal }) => operation.call(input, { signal }),
  });
export const relatednessProductQueryOptions = (
  input: z.input<typeof productShortcode>,
) => query(relatednessProductRootKey(), input, relatednessOperation);
export const placementRecommendationQueryOptions = (
  input: z.input<typeof placementRecommendationInput>,
) => query(recommendationRootKey("placement"), input, placementOperation);
export const productRecommendationQueryOptions = (
  input: z.input<typeof recommendationWorkbenchInput>,
) => query(recommendationRootKey("product"), input, productOperation);
export const duplicateProductRecommendationQueryOptions = (
  input: z.input<typeof duplicateProductRecommendationInput>,
) =>
  query(
    recommendationRootKey("duplicateProduct"),
    input,
    duplicateProductOperation,
  );
export const tagPropagationRecommendationQueryOptions = (
  input: z.input<typeof tagPropagationRecommendationInput>,
) =>
  query(
    recommendationRootKey("tagPropagation"),
    input,
    tagPropagationOperation,
  );

const mutate = <I, O>(
  key: string,
  operation: { meta: object; call(input: I): Promise<O> },
  options?: UseMutationOptions<O, Error, I>,
) =>
  mutationOptions({
    mutationKey: [["recommendations", key]] as const,
    meta: operation.meta as never,
    mutationFn: async (input: I) => {
      const result = await operation.call(input);
      markFreshReads();
      return result;
    },
    ...options,
  });
export const dismissDuplicateProductRecommendationMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recommendationOkSchema>,
    Error,
    z.input<typeof dismissDuplicateProductRecommendationInput>
  >,
) =>
  mutate("dismissDuplicateProduct", dismissDuplicateProductOperation, options);
export const dismissTagPropagationMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recommendationOkSchema>,
    Error,
    z.input<typeof dismissTagPropagationInput>
  >,
) => mutate("dismissTagPropagation", dismissTagPropagationOperation, options);
export const dismissProductRecommendationMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recommendationOkSchema>,
    Error,
    z.input<typeof dismissProductRecommendationInput>
  >,
) => mutate("dismissProduct", dismissProductOperation, options);
