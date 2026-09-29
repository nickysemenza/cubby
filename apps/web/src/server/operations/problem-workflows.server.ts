import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { deleteUnusedIngredientsInput } from "@cubby/schemas/problems";
import type { z } from "zod";

import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import { findAllViewProblemIds } from "~/server/services/problem-views.service";
import {
  deleteUnusedIngredients,
  selectIngredientsWithUnusedAliases,
  selectStaleIngredientParses,
  pruneUnusedIngredientAliasesBatch,
  reparseStaleIngredientParsesBatch,
} from "~/server/services/problems.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import {
  bindCoordinatorStream,
  defineCoordinatorStream,
  workflow,
} from "~/server/workflow-runtime";

/**
 * The problem operations with real logic. Plain detector reads live in
 * `problems.server.ts`, which loads the detector graph lazily so the
 * homepage counts read never pays for it; this module is loaded only for the
 * operations below.
 */
export type ProblemsWorkflowContext = Pick<
  AuthenticatedStartOperationContext,
  "db" | "upcLookupClient" | "usdaClient" | "actorContext" | "services"
>;

export async function deleteUnusedIngredientsWorkflow(
  context: ProblemsWorkflowContext,
  input: z.output<typeof deleteUnusedIngredientsInput>,
) {
  const shortcodes = input.ingredientIds
    ? input.ingredientIds.map((id) => parseShortcodeFor("ingredient", id))
    : input.allFromProblem
      ? (await findAllViewProblemIds(context.db, input.allFromProblem)).map(
          (id) => parseShortcodeFor("ingredient", id),
        )
      : [];
  const entityIds = await resolveAllOrThrow(
    context.db,
    "ingredient",
    shortcodes,
  );
  const deleted = await deleteUnusedIngredients(
    context.db,
    entityIds,
    input.alsoDeleteProducts,
    context.actorContext,
  );
  const shortcodeByEntityId = new Map(
    shortcodes.map((shortcode, index) => [entityIds[index], shortcode]),
  );
  return {
    deleted: deleted.deleted,
    failed: deleted.failed.map(({ id, reason }) => {
      const shortcode = shortcodeByEntityId.get(id);
      if (!shortcode) {
        throw new Error(`Deleted ingredient result returned unknown id ${id}.`);
      }
      return { id: shortcode, reason };
    }),
  };
}

const reparseStaleDefinition = defineCoordinatorStream({
  name: "problems.reparseStale",
  select: workflow<ProblemsWorkflowContext, undefined>(
    "problems.reparseStale.items",
  )
    .call("selected", async ({ context }) =>
      selectStaleIngredientParses(context.db),
    )
    .output(({ selected }) => selected),
  commit: workflow<
    ProblemsWorkflowContext,
    {
      input: undefined;
      selection: Awaited<ReturnType<typeof selectStaleIngredientParses>>;
    }
  >("problems.reparseStale.commit")
    .commit("updated", async ({ context }, { input: { selection } }) =>
      reparseStaleIngredientParsesBatch(context.db, selection),
    )
    .effect("recipes", async ({ context }, { updated }) => {
      await context.services.recipeCosting.dispatchRecompute(
        updated.recipesAffected,
        { source: "problems.reparseStale" },
      );
      return updated;
    })
    .output(({ recipes }) => ({
      updated: recipes.updated,
      recipesAffected: recipes.recipesAffected.length,
    })),
  total: (selection) => selection.length,
});
export const reparseStaleWorkflow = bindCoordinatorStream(
  reparseStaleDefinition,
  (
    context: ProblemsWorkflowContext,
    _input: undefined = undefined,
    signal: AbortSignal = new AbortController().signal,
  ) => ({
    context,
    input: undefined,
    signal,
  }),
);

const pruneAllUnusedAliasesDefinition = defineCoordinatorStream({
  name: "problems.pruneAllUnusedAliases",
  select: workflow<ProblemsWorkflowContext, undefined>(
    "problems.pruneAllUnusedAliases.items",
  )
    .call("selected", async ({ context }) =>
      selectIngredientsWithUnusedAliases(context.db),
    )
    .output(({ selected }) => selected),
  commit: workflow<
    ProblemsWorkflowContext,
    {
      input: undefined;
      selection: Awaited<ReturnType<typeof selectIngredientsWithUnusedAliases>>;
    }
  >("problems.pruneAllUnusedAliases.commit")
    .commit("pruned", async ({ context }, { input: { selection } }) =>
      pruneUnusedIngredientAliasesBatch(context.db, selection),
    )
    .output(({ pruned }) => pruned),
  total: (selection) => selection.length,
});
export const pruneAllUnusedAliasesWorkflow = bindCoordinatorStream(
  pruneAllUnusedAliasesDefinition,
  (
    context: ProblemsWorkflowContext,
    _input: undefined = undefined,
    signal: AbortSignal = new AbortController().signal,
  ) => ({
    context,
    input: undefined,
    signal,
  }),
);
