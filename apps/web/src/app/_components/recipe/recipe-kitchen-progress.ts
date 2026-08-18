import type { RecipeOut } from "@cubby/schemas/recipe";

const RECIPE_KITCHEN_PROGRESS_PREFIX = "cubby:recipe-kitchen:v1:";

interface StoredKitchenProgress {
  version: 1;
  completedStepKeys: string[];
}

export function recipeKitchenProgressStorageKey(recipeShortcode: string) {
  return `${RECIPE_KITCHEN_PROGRESS_PREFIX}${recipeShortcode}`;
}

export function recipeInstructionStepKey(sectionId: string, stepIndex: number) {
  return `${sectionId}:${stepIndex}`;
}

/** The current recipe is the authority: obsolete step keys never come back. */
export function recipeInstructionStepKeys(
  recipe: RecipeOut,
): ReadonlySet<string> {
  return new Set(
    recipe.sections.flatMap((section) =>
      section.instructions.map((_, stepIndex) =>
        recipeInstructionStepKey(section.id, stepIndex),
      ),
    ),
  );
}

export function readKitchenProgress(
  storageKey: string,
  validStepKeys: ReadonlySet<string>,
  storage: Pick<Storage, "getItem"> = localStorage,
): Set<string> {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<StoredKitchenProgress>;
    if (parsed.version !== 1 || !Array.isArray(parsed.completedStepKeys)) {
      return new Set();
    }
    return new Set(
      parsed.completedStepKeys.filter(
        (key): key is string =>
          typeof key === "string" && validStepKeys.has(key),
      ),
    );
  } catch {
    // Disabled/private storage and older malformed payloads simply start clean.
    return new Set();
  }
}

export function writeKitchenProgress(
  storageKey: string,
  doneStepKeys: ReadonlySet<string>,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  const payload: StoredKitchenProgress = {
    version: 1,
    completedStepKeys: [...doneStepKeys],
  };
  try {
    storage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Cooking can continue when browser storage is unavailable.
  }
}

export function toggleKitchenStep(
  doneStepKeys: ReadonlySet<string>,
  stepKey: string,
) {
  const next = new Set(doneStepKeys);
  if (next.has(stepKey)) next.delete(stepKey);
  else next.add(stepKey);
  return next;
}
