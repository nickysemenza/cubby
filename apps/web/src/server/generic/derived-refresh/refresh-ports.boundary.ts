import type { RecipeId } from "@cubby/schemas/identifiers";
import type { StoredRecipeTotals } from "@cubby/schemas/recipe-shared";
import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { Database } from "~/server/db";
export type DerivedEmbeddingResult =
  | { state: "ready" }
  | { state: "pending"; error?: string }
  | { state: "failed"; error: string };

export interface DerivedRefreshPorts {
  refreshEmbeddings(
    db: Database,
    refs: readonly SearchableEntityRef[],
  ): Promise<Map<string, DerivedEmbeddingResult>>;
  prepareRecipe(
    db: Database,
    id: RecipeId,
  ): Promise<{
    fingerprint: string;
    compute(): Promise<StoredRecipeTotals | null>;
  }>;
}
