import type {
  IngredientId,
  LocationId,
  ProductId,
  ProjectId,
  RecipeId,
  TaskId,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense, useMemo } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import {
  ingredientMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildTaskComboboxItem,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  pagination,
  useDeferredSearch,
  useEntitySearch,
  useEntitySearchWithDialog,
} from "./entity-search-hooks";

const CreateIngredientDialog = lazy(() =>
  import("./create-entity-dialogs").then((module) => ({
    default: module.CreateIngredientDialog,
  })),
);
const CreateLocationDialog = lazy(() =>
  import("./create-entity-dialogs").then((module) => ({
    default: module.CreateLocationDialog,
  })),
);
const CreateProductDialog = lazy(() =>
  import("./create-entity-dialogs").then((module) => ({
    default: module.CreateProductDialog,
  })),
);

export interface WithEntitySearchProps<TId extends string = string> {
  children: (props: {
    items: ComboboxItem<TId>[];
    onSearchChange: (query: string) => void;
    isLoading: boolean;
    onCreateNew?: (name: string) => Promise<ComboboxItem<TId>>;
    // Wire this to the combobox's open/close so the options query stays deferred
    // until the user actually opens the picker (off the page's critical path).
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}

export function WithIngredientSearch({
  children,
}: WithEntitySearchProps<IngredientId>) {
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
  } = useEntitySearchWithDialog<IngredientId>();
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
      {isDialogOpen && (
        <Suspense fallback={null}>
          <CreateIngredientDialog
            isOpen
            onOpenChange={setIsDialogOpen}
            onCancel={closeDialog}
            onCreate={(data) => createMutation.mutate(data)}
            isPending={createMutation.isPending}
            error={createMutation.error?.message}
            initialName={pendingName}
          />
        </Suspense>
      )}
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

export function WithLocationSearch({
  children,
}: WithEntitySearchProps<LocationId>) {
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
  } = useEntitySearchWithDialog<LocationId>();
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
      {isDialogOpen && (
        <Suspense fallback={null}>
          <CreateLocationDialog
            isOpen
            onOpenChange={setIsDialogOpen}
            onCancel={closeDialog}
            onCreate={async (data) => createMutation.mutateAsync(data)}
            isPending={createMutation.isPending}
            error={createMutation.error?.message}
            initialName={pendingName}
          />
        </Suspense>
      )}
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

export function WithProductSearch({
  children,
}: WithEntitySearchProps<ProductId>) {
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
  } = useEntitySearchWithDialog<ProductId>();
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
      {isDialogOpen && (
        <Suspense fallback={null}>
          <CreateProductDialog
            isOpen
            onOpenChange={setIsDialogOpen}
            onCancel={closeDialog}
            onCreate={(data) => createMutation.mutate(data)}
            isPending={createMutation.isPending}
            error={createMutation.error?.message}
            initialName={pendingName}
          />
        </Suspense>
      )}
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

export function WithRecipeSearch({
  children,
}: WithEntitySearchProps<RecipeId>) {
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

/**
 * Client-filtered project search — projects are a small, personal household
 * list (dozens, not thousands), so this fetches the lightweight
 * `project.options` projection once (same query/cache as `useProjectOptions`)
 * and filters it in-memory as the user types, instead of a server round trip
 * per keystroke. No create-from-picker affordance (mirrors `WithRecipeSearch`).
 */
export function WithProjectSearch({
  children,
}: WithEntitySearchProps<ProjectId>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.project.options.queryOptions(),
    enabled,
  });

  const items = useMemo(() => {
    const all = data?.map(buildProjectComboboxItem) ?? [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return all;
    return all.filter((item) => item.name.toLowerCase().includes(query));
  }, [data, searchQuery]);

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Server-searched task picker — `task.list` filtered by its `search` field,
 * same pattern as `WithRecipeSearch`. No create-from-picker affordance.
 */
export function WithTaskSearch({ children }: WithEntitySearchProps<TaskId>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.task.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled,
  });

  return (
    <>
      {children({
        items: data?.items.map(buildTaskComboboxItem) ?? [],
        onSearchChange,
        isLoading,
        onOpenChange,
      })}
    </>
  );
}
