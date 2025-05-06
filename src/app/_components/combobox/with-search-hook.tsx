"use client";

import { useState, type ReactNode } from "react";
import { type ComboboxItem } from "./combobox-types";
import { useTRPC } from "~/trpc/react";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
} from "./utils";
import { toast } from "sonner";
import { type LocationOut, type LocationType } from "~/schemas/location";
import { type ProductTopLevelOut } from "~/schemas/product";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";

interface WithEntitySearchProps {
  children: (props: {
    findItems: (query: string) => Promise<ComboboxItem[]>;
    onCreateNew?: (name: string) => Promise<ComboboxItem>;
  }) => ReactNode;
}
const pagination = {
  pageIndex: 0,
  pageSize: 20,
};

function CreateIngredientDialog({
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
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          // Prevent closing when clicking on Popover contents
          const target = e.target as HTMLElement;
          if (target.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create New Ingredient</DialogTitle>
        </DialogHeader>
        <IngredientForm
          mode="create"
          isPending={isPending}
          error={error}
          onCancel={onCancel}
          onCreate={onCreate}
          initialName={initialName}
        />
      </DialogContent>
    </Dialog>
  );
}

export function CreateLocationDialog({
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
  onCreate: (data: {
    name: string;
    type: LocationType;
    parentId: string | null;
  }) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          // Prevent closing when clicking on Popover contents
          const target = e.target as HTMLElement;
          if (target.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create New Location</DialogTitle>
        </DialogHeader>
        <LocationForm
          mode="create"
          isPending={isPending}
          error={error}
          onCancel={onCancel}
          onCreate={onCreate}
          initialName={initialName}
        />
      </DialogContent>
    </Dialog>
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
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onCreate: (data: {
    name: string;
    manufacturer: string;
    model: string | null;
    upc: string | null;
    ndb_number: number | null;
    ingredientId: string | null;
  }) => void;
  isPending: boolean;
  error?: string;
  initialName?: string;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          // Prevent closing when clicking on Popover contents
          const target = e.target as HTMLElement;
          if (target.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create New Product</DialogTitle>
        </DialogHeader>
        <ProductForm
          mode="create"
          isPending={isPending}
          error={error}
          onCancel={onCancel}
          onCreate={onCreate}
          initialName={initialName}
        />
      </DialogContent>
    </Dialog>
  );
}

export function WithIngredientSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingResolve, setPendingResolve] = useState<
    ((item: ComboboxItem) => void) | null
  >(null);
  const queryClient = useQueryClient();
  const { data } = useQuery(
    api.ingredient.list.queryOptions({
      filters: {
        nameFilter: searchQuery,
      },
      pagination,
    }),
  );

  const findItems = async (query: string): Promise<ComboboxItem[]> => {
    setSearchQuery(query);
    return data?.items.map(buildIngredientComboboxItem) ?? [];
  };

  const createMutation = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: (newIngredient: IngredientWithRecipesAndProductOut) => {
        toast.success(`Created new ingredient: ${newIngredient.name}`);
        queryClient.invalidateQueries({
          queryKey: ["ingredient", "list"],
        });
        setIsDialogOpen(false);
        if (pendingResolve) {
          pendingResolve(buildIngredientComboboxItem(newIngredient));
          setPendingResolve(null);
        }
      },
      onError: (error) => {
        toast.error(`Failed to create ingredient: ${error.message}`);
      },
    }),
  );

  const onCreateNew = async (name: string) => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem>((resolve) => {
      setPendingResolve(() => resolve);
    });
  };

  return (
    <>
      <CreateIngredientDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={() => {
          setIsDialogOpen(false);
          setPendingResolve(null);
        }}
        onCreate={(data) => {
          createMutation.mutate(data);
        }}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({ findItems, onCreateNew })}
    </>
  );
}

export function WithLocationSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingResolve, setPendingResolve] = useState<
    ((item: ComboboxItem) => void) | null
  >(null);
  const queryClient = useQueryClient();
  const { data } = useQuery(
    api.location.list.queryOptions({
      filters: {
        nameFilter: searchQuery,
      },
      pagination,
    }),
  );

  const createMutation = useMutation(
    api.location.create.mutationOptions({
      onSuccess: (newLocation: LocationOut) => {
        toast.success(`Created new location: ${newLocation.name}`);
        queryClient.invalidateQueries({
          queryKey: ["location", "list"],
        });
        setIsDialogOpen(false);
        if (pendingResolve) {
          pendingResolve(buildLocationComboboxItem(newLocation));
          setPendingResolve(null);
        }
      },
      onError: (error) => {
        toast.error(`Failed to create location: ${error.message}`);
      },
    }),
  );

  const findItems = async (query: string): Promise<ComboboxItem[]> => {
    setSearchQuery(query);
    return data?.items.map(buildLocationComboboxItem) ?? [];
  };

  const onCreateNew = async (name: string) => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem>((resolve) => {
      setPendingResolve(() => resolve);
    });
  };

  return (
    <>
      <CreateLocationDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={() => {
          setIsDialogOpen(false);
          setPendingResolve(null);
        }}
        onCreate={(data) => {
          createMutation.mutate(data);
        }}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({ findItems, onCreateNew })}
    </>
  );
}

export function WithProductSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingResolve, setPendingResolve] = useState<
    ((item: ComboboxItem) => void) | null
  >(null);
  const queryClient = useQueryClient();
  const { data } = useQuery(
    api.product.list.queryOptions({
      filters: {
        nameFilter: searchQuery,
      },
      pagination,
    }),
  );

  const createMutation = useMutation(
    api.product.create.mutationOptions({
      onSuccess: (newProduct: ProductTopLevelOut) => {
        toast.success(`Created new product: ${newProduct.name}`);
        queryClient.invalidateQueries({
          queryKey: ["product", "list"],
        });
        setIsDialogOpen(false);
        if (pendingResolve) {
          pendingResolve(buildProductComboboxItem(newProduct));
          setPendingResolve(null);
        }
      },
      onError: (error) => {
        toast.error(`Failed to create product: ${error.message}`);
      },
    }),
  );

  const findItems = async (query: string): Promise<ComboboxItem[]> => {
    setSearchQuery(query);
    return data?.items.map(buildProductComboboxItem) ?? [];
  };

  const onCreateNew = async (name: string) => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem>((resolve) => {
      setPendingResolve(() => resolve);
    });
  };

  return (
    <>
      <CreateProductDialog
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onCancel={() => {
          setIsDialogOpen(false);
          setPendingResolve(null);
        }}
        onCreate={(data) => {
          createMutation.mutate(data);
        }}
        isPending={createMutation.isPending}
        error={createMutation.error?.message}
        initialName={pendingName}
      />
      {children({ findItems, onCreateNew })}
    </>
  );
}
