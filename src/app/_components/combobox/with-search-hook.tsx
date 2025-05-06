"use client";

import { useState, type ReactNode } from "react";
import { type ComboboxItem } from "../combobox";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "~/trpc/react";
import { buildLocationComboboxItem, buildProductComboboxItem } from "./utils";

interface WithEntitySearchProps {
  children: (props: {
    findItems: (query: string) => Promise<ComboboxItem[]>;
  }) => ReactNode;
}
const pagination = {
  pageIndex: 0,
  pageSize: 20,
};
export function WithIngredientSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");

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
    return (
      data?.items.map((item: { id: string; name: string }) => ({
        id: item.id,
        name: item.name,
      })) ?? []
    );
  };
  return <>{children({ findItems })}</>;
}

export function WithLocationSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");

  const { data } = useQuery(
    api.location.list.queryOptions({
      filters: {
        nameFilter: searchQuery,
      },
      pagination,
    }),
  );

  const findItems = async (query: string): Promise<ComboboxItem[]> => {
    setSearchQuery(query);
    return data?.items.map(buildLocationComboboxItem) ?? [];
  };
  return <>{children({ findItems })}</>;
}
export function WithProductSearch({ children }: WithEntitySearchProps) {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");

  const { data } = useQuery(
    api.product.list.queryOptions({
      filters: {
        nameFilter: searchQuery,
      },
      pagination,
    }),
  );

  const findItems = async (query: string): Promise<ComboboxItem[]> => {
    setSearchQuery(query);
    return data?.items.map(buildProductComboboxItem) ?? [];
  };
  return <>{children({ findItems })}</>;
}
