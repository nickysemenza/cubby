import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { cookbookListQueryOptions } from "~/entities/cookbook.functions";

const NO_COOKBOOK_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * Full cookbook list as `{value,label}` options, name-sorted — feeds the
 * recipe list's Source filter (`optionsKey: "cookbook"`). Only a handful of
 * cookbooks exist (the Cookbook projection already orders by name), and that
 * query is already warm from the cookbook browse index and the cookbook
 * picker, so this reuses it rather than adding a dedicated options procedure
 * (contrast `useProjectOptions`/`useLocationParentOptions`, which back onto
 * their own lightweight roster queries because the full project/location
 * lists are unbounded or would need enrichment this doesn't).
 *
 * Note the field name: a cookbook's display name is `book`, not `name`.
 */
export function useCookbookOptions() {
  const { data, isLoading } = useQuery(cookbookListQueryOptions());

  const options = useMemo(
    () =>
      data?.map((cookbook) => ({
        value: cookbook.id as string,
        label: cookbook.book,
      })) ?? NO_COOKBOOK_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
