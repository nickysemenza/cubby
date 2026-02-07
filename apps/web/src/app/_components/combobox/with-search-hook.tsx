import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type { LocationCreateInput, LocationOut } from "@cubby/schemas/location";
import type {
  ProductCreateInput,
  ProductTopLevelOut,
} from "@cubby/schemas/product";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
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
  }) => ReactNode;
}

const pagination = {
  pageIndex: 0,
  pageSize: 20,
};

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
  className = "sm:max-w-lg",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
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
    >
      <ProductForm
        mode="create"
        isPending={isPending}
        error={error}
        onCancel={onCancel}
        onCreate={onCreate}
        initialName={initialName}
        initialExpectedQuantity={initialExpectedQuantity}
      />
    </CreateEntityDialogWrapper>
  );
}

export function WithIngredientSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
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

  const { data, isLoading } = useQuery(
    api.ingredient.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
  );

  const createMutation = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: (newIngredient: IngredientWithRecipesAndProductOut) => {
        toast.success(`Created new ingredient: ${newIngredient.name}`);
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [queryKeys.ingredient.list],
        });
        resolveWithEntity(buildIngredientComboboxItem(newIngredient));
      },
      onError: (error) => {
        toast.error(`Failed to create ingredient: ${error.message}`);
      },
    }),
  );

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
      })}
    </>
  );
}

export function WithLocationSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
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

  const { data, isLoading } = useQuery(
    api.location.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
  );

  const createMutation = useMutation(
    api.location.create.mutationOptions({
      onSuccess: (newLocation: LocationOut) => {
        toast.success(`Created new location: ${newLocation.name}`);
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({ queryKey: [queryKeys.location.list] });
        resolveWithEntity(buildLocationComboboxItem(newLocation));
      },
      onError: (error) => {
        toast.error(`Failed to create location: ${error.message}`);
      },
    }),
  );

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
      })}
    </>
  );
}

export function WithProductSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
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

  const { data, isLoading } = useQuery(
    api.product.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
  );

  const createMutation = useMutation(
    api.product.create.mutationOptions({
      onSuccess: (newProduct: ProductTopLevelOut) => {
        toast.success(`Created new product: ${newProduct.name}`);
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({ queryKey: [queryKeys.product.list] });
        resolveWithEntity(buildProductComboboxItem(newProduct));
      },
      onError: (error) => {
        toast.error(`Failed to create product: ${error.message}`);
      },
    }),
  );

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
      })}
    </>
  );
}

export function WithRecipeSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();

  const { data, isLoading } = useQuery(
    api.recipe.list.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
  );

  // For recipes, we don't provide the ability to create from this interface
  return (
    <>
      {children({
        items: data?.items.map(buildRecipeComboboxItem) ?? [],
        onSearchChange,
        isLoading,
      })}
    </>
  );
}
