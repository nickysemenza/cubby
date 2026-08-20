import type {
  IngredientShortcode,
  LocationShortcode,
  ProductShortcode,
  ProjectShortcode,
  RecipeShortcode,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
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
  buildLocationComboboxItemFromDetail,
  buildProductComboboxItem,
  buildProjectComboboxItem,
  buildRecipeComboboxItem,
  buildSearchHitComboboxItem,
  buildTaskComboboxItem,
  type ProductPickerIntent,
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
}: WithEntitySearchProps<IngredientShortcode>) {
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
  } = useEntitySearchWithDialog<IngredientShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "ingredient" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.ingredient.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "ingredient",
      entityTypes: ["ingredient"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.ingredient.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "ING-2222" },
      { enabled: exactCode != null },
    ),
  );

  const createMutation = useActionMutation({
    entity: "ingredient",
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
        items: searchingByCode
          ? exactItem
            ? [buildIngredientComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem<IngredientShortcode>(
                  hit,
                  "ingredient",
                ),
              ) ?? [])
            : (data?.items.map(buildIngredientComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithLocationSearch({
  children,
}: WithEntitySearchProps<LocationShortcode>) {
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
  } = useEntitySearchWithDialog<LocationShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `location.search` (not `.list`): the picker needs {id, name, type,
  // ancestors, coverImage}, so it skips the inventory-entry + product relation
  // joins and the batched product-pricing pass that `.list` pays for on every
  // keystroke.
  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "location" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.location.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
      // Explicit: the list factory's default direction is `desc` (right for a
      // `createdAt` table, backwards for a name-ordered typeahead — it opened
      // on "zipties & pads").
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "location",
      entityTypes: ["location"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.location.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "LOC-2222" },
      { enabled: exactCode != null },
    ),
  );

  const createMutation = useActionMutation({
    entity: "location",
    mutationFn: api.location.create.mutationOptions,
    success: (newLocation) =>
      savedWithBackgroundWork(
        newLocation.sideEffects,
        `Made a place for ${newLocation.name}`,
      ),
    invalidateKeys: locationMutationInvalidateKeys,
    onSuccess: (newLocation) =>
      resolveWithEntity(buildLocationComboboxItemFromDetail(newLocation)),
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
        items: searchingByCode
          ? exactItem
            ? [buildLocationComboboxItemFromDetail(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem<LocationShortcode>(hit, "location"),
              ) ?? [])
            : (data?.items.map(buildLocationComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew: openDialog,
        onOpenChange,
      })}
    </>
  );
}

export function WithProductSearch({
  children,
  intent = "reference",
}: WithEntitySearchProps<ProductShortcode> & { intent?: ProductPickerIntent }) {
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
  } = useEntitySearchWithDialog<ProductShortcode>();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  // `product.search` (not `.list`) returns the compact picker shape plus its
  // batched quantity evidence, without paying for the full product graph.
  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "product" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode,
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.product.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "PRD-2222" },
      { enabled: exactCode != null },
    ),
  );

  const createMutation = useActionMutation({
    entity: "product",
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
        items: searchingByCode
          ? exactItem
            ? [buildProductComboboxItem(exactItem, intent)]
            : []
          : (data?.items.map((item) =>
              buildProductComboboxItem(item, intent),
            ) ?? []),
        onSearchChange,
        isLoading: exactCode ? isExactLoading : isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

export function WithRecipeSearch({
  children,
}: WithEntitySearchProps<RecipeShortcode>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "recipe" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.recipe.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "recipe",
      entityTypes: ["recipe"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.recipe.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "RCP-2222" },
      { enabled: exactCode != null },
    ),
  );

  // For recipes, we don't provide the ability to create from this interface
  return (
    <>
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildRecipeComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem<RecipeShortcode>(hit, "recipe"),
              ) ?? [])
            : (data?.items.map(buildRecipeComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Project search uses the normal searchable list so notes and locations can
 * match in addition to the name. No create-from-picker affordance.
 */
export function WithProjectSearch({
  children,
}: WithEntitySearchProps<ProjectShortcode>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode =
    parsedCode?.type === "project" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.project.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "project",
      entityTypes: ["project"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.project.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "PRJ-2222" },
      { enabled: exactCode != null },
    ),
  );

  const items = searchingByCode
    ? exactItem
      ? [buildProjectComboboxItem(exactItem)]
      : []
    : searchQuery.trim()
      ? (searchHits?.map((hit) =>
          buildSearchHitComboboxItem<ProjectShortcode>(hit, "project"),
        ) ?? [])
      : (data?.items.map(buildProjectComboboxItem) ?? []);

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}

/**
 * Server-searched task picker — `task.list` filtered by its `search` field,
 * same pattern as `WithRecipeSearch`. No create-from-picker affordance.
 */
export function WithTaskSearch({
  children,
}: WithEntitySearchProps<TaskShortcode>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "task" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.task.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "task",
      entityTypes: ["task"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.task.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "TSK-2222" },
      { enabled: exactCode != null },
    ),
  );

  return (
    <>
      {children({
        items: searchingByCode
          ? exactItem
            ? [buildTaskComboboxItem(exactItem)]
            : []
          : searchQuery.trim()
            ? (searchHits?.map((hit) =>
                buildSearchHitComboboxItem<TaskShortcode>(hit, "task"),
              ) ?? [])
            : (data?.items.map(buildTaskComboboxItem) ?? []),
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onOpenChange,
      })}
    </>
  );
}
