"use client";

import { useState, type ReactNode } from "react";
import { type ComboboxItem } from "../combobox";
import { useTRPC } from "~/trpc/react";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
} from "./utils";
import { toast } from "sonner";
import { type LocationOut } from "~/schemas/location";
import { type ProductTopLevelOut } from "~/schemas/product";
import { type IngredientWithRecipesAndProductOut } from "~/schemas/combo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

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
export function WithIngredientSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
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
      },
      onError: (error) => {
        toast.error(`Failed to create ingredient: ${error.message}`);
      },
    }),
  );

  const onCreateNew = async (name: string) => {
    // todo: instead of default values or null, this should pop up a modal form
    const newIngredient = await createMutation.mutateAsync({
      name,
      aliases: [],
    });
    return buildIngredientComboboxItem(newIngredient);
  };

  return <>{children({ findItems, onCreateNew })}</>;
}

export function WithLocationSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
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
    // todo: instead of default values or null, this should pop up a modal form
    const newLocation = await createMutation.mutateAsync({
      name,
      type: "shelf", // Default type, could be improved with a type selector
      parentId: null,
    });
    return buildLocationComboboxItem(newLocation);
  };

  return <>{children({ findItems, onCreateNew })}</>;
}
export function WithProductSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");
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
    // todo: instead of default values or null, this should pop up a modal form
    const newProduct = await createMutation.mutateAsync({
      name,
      manufacturer: "generic", // Default manufacturer
      model: null,
      upc: null,
      ndb_number: null,
      ingredientId: null,
    });
    return buildProductComboboxItem(newProduct);
  };

  return <>{children({ findItems, onCreateNew })}</>;
}
