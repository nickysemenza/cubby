import * as schemas from "@cubby/schemas/meal";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import * as browser from "~/server/meal-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const rangeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof schemas.mealDateRange>)
  .handler(({ data, context }) =>
    browser.getMealsByDateRangeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const upcomingTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof schemas.mealDateRange>)
  .handler(({ data, context }) =>
    browser.getUpcomingMealSummaryForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const shoppingTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof schemas.mealDateRange>)
  .handler(({ data, context }) =>
    browser.getShoppingListForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const addTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.mealAddRecipeInput>,
  )
  .handler(({ data, context }) =>
    browser.addRecipeToMealForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const updateTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.mealUpdateRecipeInput>,
  )
  .handler(({ data, context }) =>
    browser.updateMealRecipeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const removeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof schemas.mealRecipeIdInput>,
  )
  .handler(({ data, context }) =>
    browser.removeMealRecipeForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const rangeOperation = startOperation<
  z.input<typeof schemas.mealDateRange>,
  z.output<typeof schemas.mealListOut>
>({
  operation: "meal.getByDateRange",
  transport: (data, o) => rangeTransport({ data, ...o }),
  parse: (result) => schemas.mealListOut.parse(result),
});
const upcomingOperation = startOperation<
  z.input<typeof schemas.mealDateRange>,
  z.output<typeof schemas.upcomingMealSummaryOut>
>({
  operation: "meal.upcomingSummary",
  transport: (data, o) => upcomingTransport({ data, ...o }),
  parse: (result) => schemas.upcomingMealSummaryOut.parse(result),
});
const shoppingOperation = startOperation<
  z.input<typeof schemas.mealDateRange>,
  z.output<typeof schemas.shoppingListOut>
>({
  operation: "meal.getShoppingList",
  transport: (data, o) => shoppingTransport({ data, ...o }),
  parse: (result) => schemas.shoppingListOut.parse(result),
});
const addOperation = startOperation<
  z.input<typeof schemas.mealAddRecipeInput>,
  z.output<typeof schemas.mealOut>
>({
  operation: "meal.addRecipe",
  kind: "mutation",
  transport: (data, o) => addTransport({ data, ...o }),
  parse: (result) => schemas.mealOut.parse(result),
});
const updateOperation = startOperation<
  z.input<typeof schemas.mealUpdateRecipeInput>,
  z.output<typeof schemas.mealOut>
>({
  operation: "meal.updateRecipe",
  kind: "mutation",
  transport: (data, o) => updateTransport({ data, ...o }),
  parse: (result) => schemas.mealOut.parse(result),
});
const removeOperation = startOperation<
  z.input<typeof schemas.mealRecipeIdInput>,
  z.output<typeof schemas.mealOut>
>({
  operation: "meal.removeRecipe",
  kind: "mutation",
  transport: (data, o) => removeTransport({ data, ...o }),
  parse: (result) => schemas.mealOut.parse(result),
});

export const mealDateRangeQueryOptions = (
  input: z.input<typeof schemas.mealDateRange>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.meal.byDateRange], input] as const,
    queryFn: ({ signal }) => rangeOperation.call(input, { signal }),
    meta: rangeOperation.meta,
  });
export const mealUpcomingSummaryQueryOptions = (
  input: z.input<typeof schemas.mealDateRange>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.meal.all, "upcomingSummary"], input] as const,
    queryFn: ({ signal }) => upcomingOperation.call(input, { signal }),
    meta: upcomingOperation.meta,
  });
export const mealShoppingListQueryOptions = (
  input: z.input<typeof schemas.mealDateRange>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.meal.shoppingList], input] as const,
    queryFn: ({ signal }) => shoppingOperation.call(input, { signal }),
    meta: shoppingOperation.meta,
  });
type MealMutationOptions<I> = UseMutationOptions<
  z.output<typeof schemas.mealOut>,
  Error,
  I
>;
export const mealAddRecipeMutationOptions = (
  options?: MealMutationOptions<z.input<typeof schemas.mealAddRecipeInput>>,
) =>
  mutationOptions({
    ...options,
    mutationKey: [...queryKeys.meal.all, "addRecipe"],
    mutationFn: async (input: z.input<typeof schemas.mealAddRecipeInput>) => {
      const result = await addOperation.call(input);
      return result;
    },
    meta: addOperation.meta,
  });
export const mealUpdateRecipeMutationOptions = (
  options?: MealMutationOptions<z.input<typeof schemas.mealUpdateRecipeInput>>,
) =>
  mutationOptions({
    ...options,
    mutationKey: [...queryKeys.meal.all, "updateRecipe"],
    mutationFn: async (
      input: z.input<typeof schemas.mealUpdateRecipeInput>,
    ) => {
      const result = await updateOperation.call(input);
      return result;
    },
    meta: updateOperation.meta,
  });
export const mealRemoveRecipeMutationOptions = (
  options?: MealMutationOptions<z.input<typeof schemas.mealRecipeIdInput>>,
) =>
  mutationOptions({
    ...options,
    mutationKey: [...queryKeys.meal.all, "removeRecipe"],
    mutationFn: async (input: z.input<typeof schemas.mealRecipeIdInput>) => {
      const result = await removeOperation.call(input);
      return result;
    },
    meta: removeOperation.meta,
  });
