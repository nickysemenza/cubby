import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { getErrorMessage } from "~/lib/error-utils";
import {
  ingredientMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { useTRPC } from "~/trpc/react";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildRecipeComboboxItem,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  CreateIngredientDialog,
  CreateLocationDialog,
  CreateProductDialog,
} from "./create-entity-dialogs";
import {
  pagination,
  useDeferredSearch,
  useEntitySearch,
  useEntitySearchWithDialog,
} from "./entity-search-hooks";

// Re-export the only Create*Dialog consumed outside this module (the recipe
// form's ingredient preview table), so the public import path stays stable.
export { CreateIngredientDialog };

interface WithEntitySearchProps {
  children: (props: {
    items: ComboboxItem[];
    onSearchChange: (query: string) => void;
    isLoading: boolean;
    onCreateNew?: (name: string) => Promise<ComboboxItem>;
    // Wire this to the combobox's open/close so the options query stays deferred
    // until the user actually opens the picker (off the page's critical path).
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}

export function WithIngredientSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.ingredient.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled,
  });

  const createMutation = useActionMutation({
    mutationFn: api.ingredient.create.mutationOptions,
    success: (newIngredient) =>
      savedWithBackgroundWork(
        newIngredient.sideEffects,
        `Added ${newIngredient.name} to your pantry`,
      ),
    invalidateKeys: ingredientMutationInvalidateKeys,
    onSuccess: (newIngredient) =>
      resolveWithEntity(buildIngredientComboboxItem(newIngredient)),
    error: (err) => `Failed to create ingredient: ${getErrorMessage(err)}`,
  });

  return (
    <>
      <CreateIngredientDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={closeDialog}
        onCreate={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({
        items: data?.items.map(buildIngredientComboboxItem) ?? [],
        onSearchChange,
        isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithLocationSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.location.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled,
  });

  const createMutation = useActionMutation({
    mutationFn: api.location.create.mutationOptions,
    success: (newLocation) =>
      savedWithBackgroundWork(
        newLocation.sideEffects,
        `Made a place for ${newLocation.name}`,
      ),
    invalidateKeys: locationMutationInvalidateKeys,
    onSuccess: (newLocation) =>
      resolveWithEntity(buildLocationComboboxItem(newLocation)),
    error: (err) => `Failed to create location: ${getErrorMessage(err)}`,
  });

  return (
    <>
      <CreateLocationDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={closeDialog}
        onCreate={async (data) => createMutation.mutateAsync(data)}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({
        items: data?.items.map(buildLocationComboboxItem) ?? [],
        onSearchChange,
        isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithProductSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  } = useEntitySearchWithDialog();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `product.search` (not `.list`): the picker needs only {id, name,
  // manufacturer}, so it skips the per-row USDA food enrichment + relation joins
  // that `.list` pays for.
  const { data, isLoading } = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled,
  });

  const createMutation = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: (newProduct) =>
      savedWithBackgroundWork(
        newProduct.sideEffects,
        `Added ${newProduct.name} to your shelves`,
      ),
    invalidateKeys: productMutationInvalidateKeys,
    onSuccess: (newProduct) =>
      resolveWithEntity(buildProductComboboxItem(newProduct)),
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

  // A pasted/typed UPC skips the name-only dialog and resolves via the UPC
  // lookup cascade instead; non-UPC input still opens the create dialog.
  const onCreateNew = useUpcAwareCreate(openDialog);

  return (
    <>
      <CreateProductDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={closeDialog}
        onCreate={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({
        items: data?.items.map(buildProductComboboxItem) ?? [],
        onSearchChange,
        isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

export function WithRecipeSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.recipe.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled,
  });

  // For recipes, we don't provide the ability to create from this interface
  return (
    <>
      {children({
        items: data?.items.map(buildRecipeComboboxItem) ?? [],
        onSearchChange,
        isLoading,
        onOpenChange,
      })}
    </>
  );
}
