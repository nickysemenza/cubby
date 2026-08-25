import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import * as schemas from "@cubby/schemas/ingredient";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import * as browser from "~/server/ingredient-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const byNameTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) =>
      input as z.input<typeof schemas.ingredientNameFilterInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientGetByName({ data, request: context.startOperation }),
  );
const matchesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.ingredientNamesInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientMatchNames({ data, request: context.startOperation }),
  );
const manyTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.ingredientIdsInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientGetManyByIDs({ data, request: context.startOperation }),
  );
const usagesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.ingredientIdInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientRecipeUsages({ data, request: context.startOperation }),
  );
const resolveTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) =>
      input as z.input<typeof schemas.ingredientResolvableNamesInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientResolveOrCreate({
      data,
      request: context.startOperation,
    }),
  );
const enrichmentTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) =>
      input as z.input<typeof schemas.enrichmentWorkbenchInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientEnrichmentWorkbench({
      data,
      request: context.startOperation,
    }),
  );
const mergeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.ingredientMergeInput>,
  )
  .handler(({ data, context }) =>
    browser.ingredientMerge({ data, request: context.startOperation }),
  );
const byNameOperation = startOperation<
  z.input<typeof schemas.ingredientNameFilterInput>,
  z.output<typeof schemas.ingredientWithFoodOut> | null
>({
  operation: "ingredient.getByName",
  transport: (data, o) => byNameTransport({ data, ...o }),
  parse: (result) => schemas.ingredientWithFoodOut.nullable().parse(result),
});
const matchesOperation = startOperation<
  z.input<typeof schemas.ingredientNamesInput>,
  z.output<typeof schemas.ingredientMatchesOut>
>({
  operation: "ingredient.matchNames",
  transport: (data, o) => matchesTransport({ data, ...o }),
  parse: (result) => schemas.ingredientMatchesOut.parse(result),
});
const manyOperation = startOperation<
  z.input<typeof schemas.ingredientIdsInput>,
  z.output<typeof schemas.ingredientWithFoodLeanListOut>
>({
  operation: "ingredient.getManyByIDs",
  transport: (data, o) => manyTransport({ data, ...o }),
  parse: (result) => schemas.ingredientWithFoodLeanListOut.parse(result),
});
const usagesOperation = startOperation<
  z.input<typeof schemas.ingredientIdInput>,
  z.output<typeof schemas.ingredientRecipeUsagesOut>
>({
  operation: "ingredient.recipeUsages",
  transport: (data, o) => usagesTransport({ data, ...o }),
  parse: (result) => schemas.ingredientRecipeUsagesOut.parse(result),
});
const resolveOperation = startOperation<
  z.input<typeof schemas.ingredientResolvableNamesInput>,
  z.output<typeof schemas.ingredientResolveOrCreateOut>
>({
  operation: "ingredient.resolveOrCreate",
  kind: "mutation",
  transport: (data, o) => resolveTransport({ data, ...o }),
  parse: (result) => schemas.ingredientResolveOrCreateOut.parse(result),
});
const enrichmentOperation = startOperation<
  z.input<typeof schemas.enrichmentWorkbenchInput>,
  z.output<typeof schemas.enrichmentRowsOut>
>({
  operation: "ingredient.enrichmentWorkbench",
  transport: (data, o) => enrichmentTransport({ data, ...o }),
  parse: (result) => schemas.enrichmentRowsOut.parse(result),
});
const mergeOutput = z.object({
  ingredient: schemas.ingredientOut,
  mergeSummary: schemas.ingredientMergeOut.shape.mergeSummary,
  sideEffects: mutationSideEffectsSchema,
});
const mergeOperation = startOperation<
  z.input<typeof schemas.ingredientMergeInput>,
  z.output<typeof mergeOutput>
>({
  operation: "ingredient.merge",
  kind: "mutation",
  transport: (data, o) => mergeTransport({ data, ...o }),
  parse: (result) => mergeOutput.parse(result),
});
export const ingredientGetByNameQueryOptions = (
  input: z.input<typeof schemas.ingredientNameFilterInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.ingredient.getByName, input] as const,
    queryFn: ({ signal }) => byNameOperation.call(input, { signal }),
    meta: byNameOperation.meta,
  });
export const ingredientMatchNamesQueryOptions = (
  input: z.input<typeof schemas.ingredientNamesInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.ingredient.all, "matchNames", input] as const,
    queryFn: ({ signal }) => matchesOperation.call(input, { signal }),
    meta: matchesOperation.meta,
  });
export const ingredientGetManyByIDsQueryOptions = (
  input: z.input<typeof schemas.ingredientIdsInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.ingredient.all, "getManyByIDs", input] as const,
    queryFn: ({ signal }) => manyOperation.call(input, { signal }),
    meta: manyOperation.meta,
  });
export const ingredientRecipeUsagesQueryOptions = (
  input: z.input<typeof schemas.ingredientIdInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.ingredient.all, "recipeUsages", input] as const,
    queryFn: ({ signal }) => usagesOperation.call(input, { signal }),
    meta: usagesOperation.meta,
  });
export const ingredientResolveOrCreateMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.ingredient.all, "resolveOrCreate"],
    mutationFn: async (
      input: z.input<typeof schemas.ingredientResolvableNamesInput>,
    ) => {
      const result = await resolveOperation.call(input);
      markFreshReads();
      return result;
    },
    meta: resolveOperation.meta,
  });
export const ingredientEnrichmentWorkbenchQueryOptions = (
  input: z.input<typeof schemas.enrichmentWorkbenchInput>,
) =>
  queryOptions({
    queryKey: [
      ...queryKeys.ingredient.all,
      "enrichmentWorkbench",
      input,
    ] as const,
    queryFn: ({ signal }) => enrichmentOperation.call(input, { signal }),
    meta: enrichmentOperation.meta,
  });
export const ingredientMergeMutationOptions = (
  options?: import("@tanstack/react-query").UseMutationOptions<
    z.output<typeof mergeOutput>,
    Error,
    z.input<typeof schemas.ingredientMergeInput>
  >,
) =>
  mutationOptions({
    ...options,
    mutationKey: [...queryKeys.ingredient.all, "merge"],
    mutationFn: async (input: z.input<typeof schemas.ingredientMergeInput>) => {
      const result = await mergeOperation.call(input);
      markFreshReads();
      return result;
    },
    meta: mergeOperation.meta,
  });
export const mergeIngredients = (
  input: z.input<typeof schemas.ingredientMergeInput>,
) => mergeOperation.call(input);
