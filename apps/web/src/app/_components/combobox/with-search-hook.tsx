import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type { LocationCreateInput, LocationOut } from "@cubby/schemas/location";
import type {
  ProductCreateInput,
  ProductTopLevelOut,
} from "@cubby/schemas/product";
import { useQuery } from "@tanstack/react-query";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildRecipeComboboxItem,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";

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

const pagination = {
  pageIndex: 0,
  pageSize: 20,
};

/**
 * Defer an entity-list options query until the picker is first opened (or the
 * user starts typing). Returns an `enabled` flag for the query plus the
 * `onOpenChange` handler to hand back through the render prop. Once activated it
 * stays on, so closing/reopening keeps the cached options.
 */
function useDeferredSearch(searchQuery: string) {
  const [activated, setActivated] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setActivated(true);
  }, []);
  return {
    enabled: activated || searchQuery.length > 0,
    onOpenChange,
  };
}

/**
 * Custom hook for basic entity search (no dialog).
 * Use this for simple search-only scenarios or when creating entities without a dialog.
 */
function useEntitySearch() {
  const [searchQuery, setSearchQuery] = useState("");

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  return {
    searchQuery,
    onSearchChange,
  };
}

/**
 * Custom hook for entity search with dialog-based creation.
 * Extracts common state management for search hooks that need:
 * - Search query state
 * - Dialog open/close state
 * - Promise-based dialog resolution for combobox integration
 */
function useEntitySearchWithDialog() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingResolve, setPendingResolve] = useState<
    ((item: ComboboxItem) => void) | null
  >(null);

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const openDialog = useCallback((name: string): Promise<ComboboxItem> => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem>((resolve) => {
      setPendingResolve(() => resolve);
    });
  }, []);

  const closeDialog = useCallback(() => {
    setIsDialogOpen(false);
    setPendingResolve(null);
  }, []);

  const resolveWithEntity = useCallback(
    (item: ComboboxItem) => {
      setIsDialogOpen(false);
      if (pendingResolve) {
        pendingResolve(item);
        setPendingResolve(null);
      }
    },
    [pendingResolve],
  );

  return {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  };
}

/**
 * Common dialog wrapper that prevents closing when clicking on Popover contents.
 * Used by all Create*Dialog components.
 */
function CreateEntityDialogWrapper({
  isOpen,
  onOpenChange,
  title,
  children,
  size = "md",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  size?: ComponentProps<typeof DialogContent>["size"];
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function CreateIngredientDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: { name: string; aliases: string[] }) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Ingredient"
    >
      <IngredientForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
      />
    </CreateEntityDialogWrapper>
  );
}

function CreateLocationDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: LocationCreateInput) => Promise<LocationOut>;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Location"
    >
      <LocationForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
      />
    </CreateEntityDialogWrapper>
  );
}

function CreateProductDialog({
  isOpen,
  onOpenChange,
  onCancel,
  onCreate,
  isPending,
  error,
  initialName,
  initialExpectedQuantity,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: ProductCreateInput) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
  initialExpectedQuantity?: number | null;
}) {
  return (
    <CreateEntityDialogWrapper
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Create New Product"
      size="xl"
    >
      <ProductForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
        initialExpectedQuantity={initialExpectedQuantity}
        embedded
      />
    </CreateEntityDialogWrapper>
  );
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
    success: (newIngredient: IngredientWithRecipesAndProductOut) =>
      `Added ${newIngredient.name} to your pantry.`,
    invalidateKeys: [queryKeys.ingredient.list],
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
    success: (newLocation: LocationOut) =>
      `Made a place for ${newLocation.name}.`,
    invalidateKeys: [queryKeys.location.list],
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
    success: (newProduct: ProductTopLevelOut) =>
      `Added ${newProduct.name} to your shelves.`,
    invalidateKeys: [queryKeys.product.list],
    onSuccess: (newProduct) =>
      resolveWithEntity(buildProductComboboxItem(newProduct)),
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });

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
        onCreateNew: openDialog,
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
