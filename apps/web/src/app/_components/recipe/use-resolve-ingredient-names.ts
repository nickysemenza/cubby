import { useMutation } from "@tanstack/react-query";
import { uniqBy } from "es-toolkit";
import { ingredient } from "~/app/ingredients/ingredient.functions";
import type { IngredientMatch } from "./use-ingredient-matches";

/**
 * Cache key for a requested ingredient name. Must match how the server keys the
 * names it was handed (`resolveOrCreateIngredients` trims, then lowercases) —
 * a client that keyed on the raw name would miss the result for anything the
 * server normalized differently, and the miss aborts the whole import.
 */
export const ingredientNameKey = (name: string) => name.trim().toLowerCase();

/**
 * Resolve ingredient names to DB rows via the server's batch resolve-or-create,
 * in one round-trip for the whole list.
 *
 * Deliberately NOT a client-side "look up, then create the misses": the lookup
 * that would feed is a cached query (60s default staleTime), so a second import
 * run inside that window read a stale "not found" for a name the first run had
 * just created, tried to create it again, and took a unique violation on
 * lower(name) — which aborted the whole import and left the form holding a
 * recipe name and no ingredients. The server matches and inserts in the same
 * call, so a repeat run resolves to the existing row. It also matches
 * case-insensitively and on aliases, which a per-name create cannot.
 */
export function useResolveIngredientNames() {
  const resolveMutation = useMutation(
    ingredient.resolveOrCreate.mutationOptions(),
  );

  /** Lowercased requested name → its resolved ingredient. */
  const resolveNames = async (
    names: string[],
  ): Promise<Map<string, IngredientMatch>> => {
    const unique = uniqBy(
      names.map((name) => name.trim()).filter((name) => name.length > 0),
      ingredientNameKey,
    );
    if (unique.length === 0) return new Map();

    const results = await resolveMutation.mutateAsync({ names: unique });
    // `canonicalName`/`aliases` are the matched row's own — the requested name
    // may be a casing variant of it, or one of its aliases.
    return new Map(
      results.map((result) => [
        ingredientNameKey(result.name),
        { id: result.id, name: result.canonicalName, aliases: result.aliases },
      ]),
    );
  };

  return { resolveNames, isResolving: resolveMutation.isPending };
}

/** Single-name convenience over {@link useResolveIngredientNames}. */
export function useResolveIngredientName() {
  const { resolveNames, isResolving } = useResolveIngredientNames();
  const resolveName = async (name: string): Promise<IngredientMatch> => {
    const match = (await resolveNames([name])).get(ingredientNameKey(name));
    if (!match) throw new Error(`Failed to resolve ingredient: ${name}`);
    return match;
  };
  return { resolveName, isResolving };
}
